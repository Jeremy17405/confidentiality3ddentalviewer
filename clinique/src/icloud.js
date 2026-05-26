'use strict'

const { DAVClient } = require('tsdav')
const { upsertPatient, logSync } = require('./database')
const { invalidateIndex } = require('./matching')
const logger = require('./logger')

const SYNC_INTERVAL = parseInt(process.env.ICLOUD_SYNC_INTERVAL || '300000')

// Parse un vCard pour extraire nom, prénom et téléphone
function parseVCard(vcardStr) {
  const lines = vcardStr.replace(/\r\n /g, '').replace(/\r\n\t/g, '').split(/\r\n|\n/)
  const get = (key) => {
    const line = lines.find(l => l.toUpperCase().startsWith(key.toUpperCase() + ':') ||
                                  l.toUpperCase().startsWith(key.toUpperCase() + ';'))
    if (!line) return null
    return line.split(':').slice(1).join(':').trim()
  }

  // Nom structuré : NOM;PRÉNOM;;;
  const nLine = get('N')
  let nom = '', prenom = ''
  if (nLine) {
    const parts = nLine.split(';')
    nom = parts[0]?.trim() || ''
    prenom = parts[1]?.trim() || ''
  }
  if (!nom) {
    const fnLine = get('FN')
    if (fnLine) {
      const parts = fnLine.trim().split(/\s+/)
      nom = parts[parts.length - 1] || ''
      prenom = parts.slice(0, -1).join(' ') || ''
    }
  }

  // Téléphones (peut y en avoir plusieurs)
  const phones = lines
    .filter(l => l.toUpperCase().startsWith('TEL'))
    .map(l => l.split(':').slice(1).join(':').trim())
    .filter(Boolean)

  if (!nom && !prenom) return null
  if (!phones.length) return null

  return { nom, prenom, phones }
}

async function syncContacts() {
  const email = process.env.ICLOUD_EMAIL
  const password = process.env.ICLOUD_APP_PASSWORD

  if (!email || !password) {
    logger.warn('iCloud : ICLOUD_EMAIL ou ICLOUD_APP_PASSWORD manquant dans .env')
    return
  }

  try {
    const client = new DAVClient({
      serverUrl: 'https://contacts.icloud.com',
      credentials: { username: email, password },
      authMethod: 'Basic',
      defaultAccountType: 'carddav'
    })

    await client.login()
    const addressBooks = await client.fetchAddressBooks()

    if (!addressBooks.length) {
      logger.warn('iCloud : aucun carnet d'adresses trouvé')
      return
    }

    let added = 0, updated = 0, skipped = 0

    for (const ab of addressBooks) {
      const cards = await client.fetchVCards({ addressBook: ab })

      for (const card of cards) {
        if (!card.data) continue
        const parsed = parseVCard(card.data)
        if (!parsed) { skipped++; continue }

        for (const phone of parsed.phones) {
          const result = upsertPatient({
            nom: parsed.nom,
            prenom: parsed.prenom,
            telephone: phone,
            source: 'icloud'
          })
          if (result) added++
        }
      }
    }

    invalidateIndex()
    logger.info({ added, updated, skipped }, 'Sync iCloud terminée')
    logSync('icloud', 'ok', { added, skipped })
  } catch (err) {
    logger.error({ err }, 'Erreur sync iCloud')
    logSync('icloud', 'erreur', { message: err.message })
  }
}

function startSync() {
  logger.info({ interval: SYNC_INTERVAL / 1000 + 's' }, 'Démarrage sync iCloud')
  syncContacts()
  setInterval(syncContacts, SYNC_INTERVAL)
}

module.exports = { startSync, syncContacts }
