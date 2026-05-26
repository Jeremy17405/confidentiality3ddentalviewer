'use strict'

const { google } = require('googleapis')
const fs = require('fs')
const path = require('path')
const { findPatient } = require('./matching')
const { upsertRappel, logSync, normalizePhone } = require('./database')
const logger = require('./logger')

const TOKEN_PATH = path.resolve('./data/google_token.json')
const CREDENTIALS_PATH = path.resolve('./data/google_credentials.json')
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary'
const POLL_INTERVAL = parseInt(process.env.CALENDAR_POLL_INTERVAL || '120000')

let oAuth2Client = null

function getOAuthClient() {
  if (oAuth2Client) return oAuth2Client

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH))
  const { client_id, client_secret, redirect_uris } = creds.web || creds.installed
  oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    process.env.GOOGLE_REDIRECT_URI || redirect_uris[0]
  )

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH))
    oAuth2Client.setCredentials(token)
    oAuth2Client.on('tokens', tokens => {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH))
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }))
    })
  }

  return oAuth2Client
}

function getAuthUrl() {
  const client = getOAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  })
}

async function saveToken(code) {
  const client = getOAuthClient()
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens))
  logger.info('Token Google Calendar sauvegardé')
}

function isAuthenticated() {
  return fs.existsSync(TOKEN_PATH)
}

// Retourne les événements des 14 prochains jours
async function fetchUpcomingEvents() {
  const auth = getOAuthClient()
  const calendar = google.calendar({ version: 'v3', auth })

  const now = new Date()
  const inTwoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: inTwoWeeks.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250
  })

  return res.data.items || []
}

// Extrait un numéro de téléphone depuis la description d'un événement
function extractPhoneFromDescription(description) {
  if (!description) return null
  // Chercher des patterns de numéros israéliens ou internationaux
  const match = description.match(/(\+972[\d\s\-]{9,}|05\d[\d\s\-]{7,}|\+[\d\s\-]{10,})/)
  if (!match) return null
  return normalizePhone(match[1])
}

async function updateEventDescription(eventId, description) {
  const auth = getOAuthClient()
  const calendar = google.calendar({ version: 'v3', auth })

  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: { description }
  })
}

async function pollAndEnrich() {
  if (!isAuthenticated()) {
    logger.warn('Google Calendar : pas encore authentifié')
    return
  }

  try {
    const events = await fetchUpcomingEvents()
    let enriched = 0

    for (const event of events) {
      const title = event.summary || ''
      const description = event.description || ''
      const eventStart = event.start?.dateTime || event.start?.date
      if (!eventStart) continue

      // Chercher un numéro déjà présent
      let phone = extractPhoneFromDescription(description)

      if (!phone) {
        // Essayer de matcher le titre avec un patient
        const match = findPatient(title)
        if (match) {
          phone = match.patient.telephone_normalise
          const newDesc = `${description}\n📱 ${phone}`.trim()
          await updateEventDescription(event.id, newDesc)
          logger.info({ title, patient: `${match.patient.prenom} ${match.patient.nom}`, score: match.score }, 'Événement enrichi')
          enriched++
        }
      }

      // Enregistrer en base pour les rappels
      upsertRappel({
        event_id: event.id,
        patient_telephone: phone,
        event_titre: title,
        event_start: eventStart
      })
    }

    if (enriched > 0) {
      logSync('calendar', 'ok', { events: events.length, enriched })
    }
  } catch (err) {
    logger.error({ err }, 'Erreur polling Google Calendar')
    logSync('calendar', 'erreur', { message: err.message })
  }
}

function startPolling() {
  logger.info({ interval: POLL_INTERVAL / 1000 + 's' }, 'Démarrage polling Google Calendar')
  pollAndEnrich()
  setInterval(pollAndEnrich, POLL_INTERVAL)
}

module.exports = { startPolling, getAuthUrl, saveToken, isAuthenticated, pollAndEnrich }
