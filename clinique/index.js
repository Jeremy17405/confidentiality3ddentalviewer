'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const logger = require('./src/logger')

// Créer les dossiers nécessaires
for (const dir of ['./data', './auth', './logs']) {
  fs.mkdirSync(path.resolve(dir), { recursive: true })
}

const { connect } = require('./src/whatsapp')
const { startPolling } = require('./src/calendar')
const { startSync } = require('./src/icloud')
const { startScheduler } = require('./src/reminders')
const { start: startWeb } = require('./src/web')

async function main() {
  logger.info('═══════════════════════════════════════')
  logger.info(' 🦷  Clinique WhatsApp Reminders')
  logger.info('═══════════════════════════════════════')

  // Interface web (démarre en premier pour Google OAuth si besoin)
  startWeb()

  // WhatsApp (affiche QR code au premier démarrage)
  await connect()

  // Sync iCloud contacts
  startSync()

  // Polling Google Calendar + enrichissement
  startPolling()

  // Planificateur de rappels
  startScheduler()

  logger.info('Système démarré ✓')
}

main().catch(err => {
  logger.error({ err }, 'Erreur fatale au démarrage')
  process.exit(1)
})
