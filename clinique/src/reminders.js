'use strict'

const cron = require('node-cron')
const { getRappelsToSend, markRappelSent, markRappelEchec } = require('./database')
const { sendMessage, isConnected } = require('./whatsapp')
const logger = require('./logger')

const CRON = process.env.REMINDER_CRON || '0 8 * * 0-5'

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December']

function formatDateHebrew(d) {
  const day = HE_DAYS[d.getDay()]
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `יום ${day} ${dd}/${mm}/${yyyy}`
}

function formatDateEnglish(d) {
  const day = EN_DAYS[d.getDay()]
  const month = EN_MONTHS[d.getMonth()]
  return `${day}, ${month} ${d.getDate()}, ${d.getFullYear()}`
}

function formatTime(d) {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function toJerusalemDate(isoString) {
  return new Date(new Date(isoString).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))
}

function buildMessage(rappel) {
  const d = toJerusalemDate(rappel.event_start)
  const heDate = formatDateHebrew(d)
  const enDate = formatDateEnglish(d)
  const time = formatTime(d)

  return [
    'THE DENTIST | מרפאת שיניים',
    '',
    'שלום, אנו שמחים לאשר את תורך הבא במרפאה שלנו.',
    `🗓️ ${heDate}`,
    `⏰ בשעה ${time}`,
    '',
    'נבקש להודיע לנו על כל שינוי לפחות 24 שעות מראש. נשמח לראותך.',
    '',
    'Hello, we are pleased to confirm your upcoming appointment in our clinic.',
    `🗓️ ${enDate}`,
    `⏰ at ${time}`,
    '',
    'Kindly inform us at least 24 hours in advance for any changes. We look forward to welcoming you.',
    '',
    '📍 Waze: https://waze.com/ul/hsv9h9np0v'
  ].join('\n')
}

// Vendredi → rappels pour dimanche (on saute samedi/Shabbat)
// Sinon → rappels pour demain
function getTargetDate() {
  const now = new Date()
  const day = now.getDay() // 0=dim, 5=ven, 6=sam

  const target = new Date(now)
  target.setHours(0, 0, 0, 0)
  target.setDate(target.getDate() + (day === 5 ? 2 : 1))

  return target.toISOString().split('T')[0] // YYYY-MM-DD
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
