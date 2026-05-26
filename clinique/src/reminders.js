'use strict'

const cron = require('node-cron')
const { getRappelsToSend, markRappelSent, markRappelEchec } = require('./database')
const { sendMessage, isConnected } = require('./whatsapp')
const logger = require('./logger')

const CRON = process.env.REMINDER_CRON || '0 8 * * 0-5'
const MESSAGE_TEMPLATE = process.env.REMINDER_MESSAGE ||
  'שלום {prenom},\nתזכורת לתור שלך ב{clinique}\n📅 {date} בשעה {heure}\n\nלביטול נא ליצור קשר: {telephone}\nתודה! 🦷'

function formatDate(isoString) {
  const d = new Date(isoString)
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  const dayName = days[d.getDay()]
  const date = d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
  return `יום ${dayName} ${date}`
}

function formatTime(isoString) {
  const d = new Date(isoString)
  return d.toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

// Détermine la date cible pour les rappels d'aujourd'hui
// Vendredi → rappels pour dimanche (on saute samedi/Shabbat)
// Sinon → rappels pour demain
function getTargetDate() {
  const now = new Date()
  const day = now.getDay() // 0=dim, 5=ven, 6=sam

  const target = new Date(now)
  target.setHours(0, 0, 0, 0)

  if (day === 5) {
    // Vendredi → dimanche
    target.setDate(target.getDate() + 2)
  } else {
    target.setDate(target.getDate() + 1)
  }

  return target.toISOString().split('T')[0] // YYYY-MM-DD
}

function buildMessage(rappel) {
  const title = rappel.event_titre || ''
  // Extraire prénom depuis le titre si possible
  const parts = title.trim().split(/\s+/)
  const prenom = parts[0] || ''

  return MESSAGE_TEMPLATE
    .replace('{prenom}', prenom)
    .replace('{nom}', parts.slice(1).join(' ') || '')
    .replace('{clinique}', process.env.CLINIC_NAME || 'המרפאה')
    .replace('{date}', formatDate(rappel.event_start))
    .replace('{heure}', formatTime(rappel.event_start))
    .replace('{telephone}', process.env.CLINIC_PHONE || '')
}

async function sendReminders() {
  if (!isConnected()) {
    logger.warn('Rappels ignorés : WhatsApp non connecté')
    return
  }

  const targetDate = getTargetDate()
  logger.info({ targetDate }, 'Envoi des rappels')

  const rappels = getRappelsToSend(targetDate)
  logger.info({ count: rappels.length }, 'Rappels à envoyer')

  for (const rappel of rappels) {
    try {
      const message = buildMessage(rappel)
      await sendMessage(rappel.patient_telephone, message)
      markRappelSent(rappel.event_id, message)

      // Pause entre messages pour ne pas déclencher les filtres WhatsApp
      await new Promise(r => setTimeout(r, 2000))
    } catch (err) {
      logger.error({ err, event_id: rappel.event_id }, 'Échec envoi rappel')
      markRappelEchec(rappel.event_id, err.message)
    }
  }

  logger.info('Rappels terminés')
}

function startScheduler() {
  logger.info({ cron: CRON }, 'Planificateur de rappels démarré')
  cron.schedule(CRON, sendReminders, { timezone: 'Asia/Jerusalem' })
}

module.exports = { startScheduler, sendReminders }
