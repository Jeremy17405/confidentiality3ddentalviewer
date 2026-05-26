'use strict'

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const path = require('path')
const logger = require('./logger')

const AUTH_PATH = path.resolve('./auth')

let sock = null
let isReady = false

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: logger.child({ module: 'baileys' }),
    browser: ['Clinique', 'Chrome', '1.0.0'],
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info('─────────────────────────────────────────')
      logger.info('Scannez le QR code avec WhatsApp Business')
      logger.info('─────────────────────────────────────────')
    }

    if (connection === 'open') {
      isReady = true
      logger.info('WhatsApp connecté ✓')
    }

    if (connection === 'close') {
      isReady = false
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 0
      const reconnect = code !== DisconnectReason.loggedOut

      logger.warn({ code }, `WhatsApp déconnecté — reconnexion: ${reconnect}`)

      if (reconnect) {
        setTimeout(connect, 5000)
      } else {
        logger.error('Session WhatsApp expirée. Supprimez ./auth et redémarrez pour rescanner.')
      }
    }
  })
}

async function sendMessage(telephone, message) {
  if (!isReady || !sock) {
    throw new Error('WhatsApp non connecté')
  }

  // Baileys attend le format JID : 972XXXXXXXXX@s.whatsapp.net
  const jid = telephone.replace('+', '') + '@s.whatsapp.net'

  await sock.sendMessage(jid, { text: message })
  logger.info({ telephone }, 'Message WhatsApp envoyé')
}

function isConnected() {
  return isReady
}

module.exports = { connect, sendMessage, isConnected }
