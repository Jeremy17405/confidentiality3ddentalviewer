'use strict'

const Fuse = require('fuse.js')
const { getAllPatients } = require('./database')

const THRESHOLD = parseFloat(process.env.MATCHING_THRESHOLD || '0.72')

// Normalise un nom : minuscules, sans accents, mots triés alphabétiquement
function normalizeName(str) {
  if (!str) return ''
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Garder lettres hébraïques, latines, espaces
    .replace(/[^a-zא-ת\s]/g, '')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ')
}

function buildIndex(patients) {
  const indexed = patients.map(p => ({
    ...p,
    _search: normalizeName(`${p.prenom || ''} ${p.nom}`)
  }))

  return new Fuse(indexed, {
    keys: ['_search'],
    threshold: 1 - THRESHOLD, // Fuse : 0=exact, 1=tout → on inverse
    includeScore: true,
    distance: 100,
    minMatchCharLength: 2
  })
}

let _index = null
let _lastBuilt = 0
const INDEX_TTL = 60_000 // reconstruire l'index max toutes les 60s

function getIndex() {
  const now = Date.now()
  if (!_index || now - _lastBuilt > INDEX_TTL) {
    _index = buildIndex(getAllPatients())
    _lastBuilt = now
  }
  return _index
}

function invalidateIndex() {
  _index = null
}

/**
 * Cherche le patient le plus proche d'un titre d'événement.
 * Retourne { patient, score } ou null si aucun match suffisant.
 */
function findPatient(eventTitle) {
  if (!eventTitle) return null

  const query = normalizeName(eventTitle)
  if (!query) return null

  const results = getIndex().search(query)
  if (!results.length) return null

  const best = results[0]
  const score = 1 - (best.score || 0) // on remet dans le sens 0→1

  if (score < THRESHOLD) return null

  return { patient: best.item, score: parseFloat(score.toFixed(3)) }
}

module.exports = { findPatient, normalizeName, invalidateIndex }
