'use strict'

const Database = require('better-sqlite3')
const path = require('path')
require('dotenv').config()

const DB_PATH = process.env.DB_PATH || './data/clinique.db'

let db

function getDb() {
  if (!db) {
    db = new Database(path.resolve(DB_PATH))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    init()
  }
  return db
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      nom                 TEXT NOT NULL,
      prenom              TEXT,
      telephone           TEXT NOT NULL,
      telephone_normalise TEXT NOT NULL UNIQUE,
      notes               TEXT,
      source              TEXT DEFAULT 'manual',
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rappels (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id          TEXT NOT NULL UNIQUE,
      patient_telephone TEXT,
      event_titre       TEXT,
      event_start       DATETIME,
      statut            TEXT DEFAULT 'en_attente',
      message_envoye    TEXT,
      sent_at           DATETIME,
      erreur            TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT,
      statut     TEXT,
      details    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_patients_nom ON patients(nom);
    CREATE INDEX IF NOT EXISTS idx_rappels_event ON rappels(event_id);
    CREATE INDEX IF NOT EXISTS idx_rappels_start ON rappels(event_start);
  `)
}

// ─── Patients ─────────────────────────────────────────────────────

function upsertPatient({ nom, prenom, telephone, source = 'manual', notes = null }) {
  const tel = normalizePhone(telephone)
  if (!tel) return null

  const existing = getDb()
    .prepare('SELECT id FROM patients WHERE telephone_normalise = ?')
    .get(tel)

  if (existing) {
    getDb()
      .prepare(`UPDATE patients SET nom=?, prenom=?, source=?, updated_at=CURRENT_TIMESTAMP
                WHERE telephone_normalise=?`)
      .run(nom, prenom || null, source, tel)
    return existing.id
  }

  const result = getDb()
    .prepare(`INSERT INTO patients (nom, prenom, telephone, telephone_normalise, source, notes)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(nom, prenom || null, telephone, tel, source, notes)
  return result.lastInsertRowid
}

function getAllPatients() {
  return getDb()
    .prepare('SELECT * FROM patients ORDER BY nom, prenom')
    .all()
}

function searchPatients(query) {
  const q = `%${query}%`
  return getDb()
    .prepare(`SELECT * FROM patients
              WHERE nom LIKE ? OR prenom LIKE ? OR telephone LIKE ?
              ORDER BY nom, prenom`)
    .all(q, q, q)
}

function getPatientByPhone(telephone_normalise) {
  return getDb()
    .prepare('SELECT * FROM patients WHERE telephone_normalise = ?')
    .get(telephone_normalise)
}

function deletePatient(id) {
  getDb().prepare('DELETE FROM patients WHERE id = ?').run(id)
}

// ─── Rappels ──────────────────────────────────────────────────────

function upsertRappel({ event_id, patient_telephone, event_titre, event_start }) {
  const existing = getDb()
    .prepare('SELECT id, statut FROM rappels WHERE event_id = ?')
    .get(event_id)

  if (existing) {
    if (existing.statut === 'envoye') return existing
    getDb()
      .prepare(`UPDATE rappels SET patient_telephone=?, event_titre=?, event_start=?
                WHERE event_id=?`)
      .run(patient_telephone || null, event_titre, event_start, event_id)
    return existing
  }

  getDb()
    .prepare(`INSERT INTO rappels (event_id, patient_telephone, event_titre, event_start)
              VALUES (?, ?, ?, ?)`)
    .run(event_id, patient_telephone || null, event_titre, event_start)
}

function getRappelsToSend(dateStr) {
  return getDb()
    .prepare(`SELECT * FROM rappels
              WHERE date(event_start) = date(?)
              AND statut = 'en_attente'
              AND patient_telephone IS NOT NULL`)
    .all(dateStr)
}

function markRappelSent(event_id, message) {
  getDb()
    .prepare(`UPDATE rappels SET statut='envoye', message_envoye=?, sent_at=CURRENT_TIMESTAMP
              WHERE event_id=?`)
    .run(message, event_id)
}

function markRappelEchec(event_id, erreur) {
  getDb()
    .prepare(`UPDATE rappels SET statut='echec', erreur=? WHERE event_id=?`)
    .run(erreur, event_id)
}

function getRecentRappels(limit = 50) {
  return getDb()
    .prepare(`SELECT * FROM rappels ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
}

// ─── Sync log ─────────────────────────────────────────────────────

function logSync(type, statut, details = null) {
  getDb()
    .prepare('INSERT INTO sync_log (type, statut, details) VALUES (?, ?, ?)')
    .run(type, statut, details ? JSON.stringify(details) : null)
}

function getRecentSyncLogs(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?')
    .all(limit)
}

// ─── Utilitaires ──────────────────────────────────────────────────

function normalizePhone(tel) {
  if (!tel) return null
  let clean = tel.replace(/[\s\-().+]/g, '')

  // Israël : 05X → +9725X
  if (/^05\d{8}$/.test(clean)) {
    clean = '+972' + clean.slice(1)
  }
  // 5X sans préfixe
  else if (/^5\d{8}$/.test(clean)) {
    clean = '+972' + clean
  }
  // 972...
  else if (/^972\d{9}$/.test(clean)) {
    clean = '+' + clean
  }
  // déjà +972
  else if (/^\+972\d{9}$/.test(clean)) {
    // ok
  }

  if (!clean.startsWith('+')) return null
  return clean
}

module.exports = {
  getDb,
  upsertPatient,
  getAllPatients,
  searchPatients,
  getPatientByPhone,
  deletePatient,
  upsertRappel,
  getRappelsToSend,
  markRappelSent,
  markRappelEchec,
  getRecentRappels,
  logSync,
  getRecentSyncLogs,
  normalizePhone
}
