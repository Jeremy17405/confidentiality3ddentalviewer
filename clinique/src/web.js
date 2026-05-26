'use strict'

const express = require('express')
const crypto = require('crypto')
const { getAllPatients, searchPatients, upsertPatient, deletePatient, getRecentRappels, getRecentSyncLogs } = require('./database')
const { invalidateIndex } = require('./matching')
const { getAuthUrl, saveToken, isAuthenticated, pollAndEnrich } = require('./calendar')
const { syncContacts } = require('./icloud')
const { sendReminders } = require('./reminders')
const { isConnected } = require('./whatsapp')
const logger = require('./logger')

const PORT = parseInt(process.env.WEB_PORT || '3000')
const WEB_SECRET = process.env.WEB_SECRET || ''

// Sessions en mémoire : token → expiry timestamp
const sessions = new Map()
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000 // 7 jours

function createSession() {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + SESSION_TTL)
  return token
}

function isValidSession(token) {
  if (!token) return false
  const expiry = sessions.get(token)
  if (!expiry) return false
  if (Date.now() > expiry) { sessions.delete(token); return false }
  return true
}

function getTokenFromReq(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]+)/)
  return match ? match[1] : null
}

function authMiddleware(req, res, next) {
  // Routes publiques : login
  if (req.path === '/login') return next()
  if (!isValidSession(getTokenFromReq(req))) return res.redirect('/login')
  next()
}

function html(title, body) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — מרפאה</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; direction: rtl; }
    nav { background: #1a5276; color: white; padding: 12px 24px; display: flex; gap: 20px; align-items: center; }
    nav a { color: white; text-decoration: none; font-weight: 500; }
    nav a:hover { text-decoration: underline; }
    nav .brand { font-size: 1.1em; font-weight: 700; margin-left: auto; }
    .container { max-width: 960px; margin: 24px auto; padding: 0 16px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    h1 { font-size: 1.4em; margin-bottom: 16px; color: #1a5276; }
    h2 { font-size: 1.1em; margin-bottom: 12px; color: #444; }
    .status { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: .85em; font-weight: 600; }
    .ok { background: #d4efdf; color: #1e8449; }
    .warn { background: #fdebd0; color: #b9770e; }
    .err { background: #fadbd8; color: #c0392b; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid #eee; font-size: .9em; }
    th { background: #f0f4f8; font-weight: 600; color: #555; }
    tr:hover td { background: #fafafa; }
    input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 5px; font-size: .95em; margin-bottom: 10px; }
    .btn { display: inline-block; padding: 8px 18px; border-radius: 5px; border: none; cursor: pointer; font-size: .9em; font-weight: 600; text-decoration: none; }
    .btn-primary { background: #1a5276; color: white; }
    .btn-danger { background: #c0392b; color: white; }
    .btn-success { background: #1e8449; color: white; }
    .btn-sm { padding: 4px 10px; font-size: .8em; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .alert { padding: 10px 14px; border-radius: 5px; margin-bottom: 16px; }
    .alert-success { background: #d4efdf; color: #1e8449; }
    .alert-error { background: #fadbd8; color: #c0392b; }
    form { }
    label { font-size: .85em; font-weight: 600; color: #555; display: block; margin-bottom: 3px; }
  </style>
</head>
<body>
<nav>
  <a href="/">🏠 לוח בקרה</a>
  <a href="/patients">👥 מטופלים</a>
  <a href="/patients/new">➕ מטופל חדש</a>
  <a href="/logs">📋 לוגים</a>
  <a href="/settings">⚙️ הגדרות</a>
  <a href="/logout" style="margin-right:auto;opacity:.8">🔒 יציאה</a>
  <span class="brand">🦷 THE DENTIST</span>
</nav>
<div class="container">${body}</div>
</body></html>`
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>כניסה — THE DENTIST</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #1a5276; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; }
    .box { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 360px; }
    h1 { text-align: center; color: #1a5276; margin-bottom: 8px; font-size: 1.3em; }
    p { text-align: center; color: #777; margin-bottom: 24px; font-size: .9em; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px;
            font-size: 1em; margin-bottom: 14px; direction: ltr; }
    button { width: 100%; padding: 11px; background: #1a5276; color: white;
             border: none; border-radius: 6px; font-size: 1em; font-weight: 600; cursor: pointer; }
    .err { color: #c0392b; text-align: center; margin-bottom: 12px; font-size: .9em; }
  </style>
</head>
<body>
<div class="box">
  <h1>🦷 THE DENTIST</h1>
  <p>מערכת ניהול תורים</p>
  ${error ? `<p class="err">${error}</p>` : ''}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="סיסמה" autofocus>
    <button type="submit">כניסה</button>
  </form>
</div>
</body></html>`
}

function start() {
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())

  // ── Auth ──────────────────────────────────────────────────────────
  app.use(authMiddleware)

  app.get('/login', (req, res) => {
    if (isValidSession(getTokenFromReq(req))) return res.redirect('/')
    res.send(loginPage())
  })

  app.post('/login', (req, res) => {
    if (!WEB_SECRET) return res.redirect('/')
    if (req.body.password === WEB_SECRET) {
      const token = createSession()
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}`)
      return res.redirect('/')
    }
    res.send(loginPage('סיסמה שגויה — mot de passe incorrect'))
  })

  app.get('/logout', (req, res) => {
    const token = getTokenFromReq(req)
    if (token) sessions.delete(token)
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0')
    res.redirect('/login')
  })

  // ── Dashboard ─────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const rappels = getRecentRappels(10)
    const syncs = getRecentSyncLogs(5)
    const waStatus = isConnected()
    const gcalStatus = isAuthenticated()

    const rappelRows = rappels.map(r => {
      const statusClass = r.statut === 'envoye' ? 'ok' : r.statut === 'echec' ? 'err' : 'warn'
      const date = r.event_start ? new Date(r.event_start).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—'
      return `<tr>
        <td>${r.event_titre || '—'}</td>
        <td>${r.patient_telephone || '—'}</td>
        <td>${date}</td>
        <td><span class="status ${statusClass}">${r.statut}</span></td>
      </tr>`
    }).join('')

    res.send(html('לוח בקרה', `
      <h1>לוח בקרה</h1>
      <div class="grid2">
        <div class="card">
          <h2>סטטוס מערכת</h2>
          <p>WhatsApp: <span class="status ${waStatus ? 'ok' : 'err'}">${waStatus ? 'מחובר ✓' : 'מנותק ✗'}</span></p>
          <br>
          <p>Google Calendar: <span class="status ${gcalStatus ? 'ok' : 'warn'}">${gcalStatus ? 'מחובר ✓' : 'לא מחובר'}</span></p>
        </div>
        <div class="card">
          <h2>פעולות מהירות</h2>
          <form method="POST" action="/actions/sync-icloud" style="display:inline">
            <button class="btn btn-primary btn-sm">🔄 סנכרן iCloud עכשיו</button>
          </form>&nbsp;
          <form method="POST" action="/actions/sync-calendar" style="display:inline">
            <button class="btn btn-primary btn-sm">📅 רענן לוח שנה</button>
          </form>&nbsp;
          <form method="POST" action="/actions/send-reminders" style="display:inline">
            <button class="btn btn-success btn-sm">📨 שלח תזכורות עכשיו</button>
          </form>
        </div>
      </div>
      <div class="card">
        <h2>תזכורות אחרונות</h2>
        <table>
          <thead><tr><th>תור</th><th>טלפון</th><th>תאריך</th><th>סטטוס</th></tr></thead>
          <tbody>${rappelRows || '<tr><td colspan="4">אין תזכורות עדיין</td></tr>'}</tbody>
        </table>
      </div>
    `))
  })

  // ── Patients ──────────────────────────────────────────────────────
  app.get('/patients', (req, res) => {
    const query = req.query.q || ''
    const patients = query ? searchPatients(query) : getAllPatients()

    const rows = patients.map(p => `<tr>
      <td>${p.prenom || ''} ${p.nom}</td>
      <td>${p.telephone}</td>
      <td><span class="status ok">${p.source}</span></td>
      <td>
        <a href="/patients/${p.id}/edit" class="btn btn-primary btn-sm">✏️</a>
        <form method="POST" action="/patients/${p.id}/delete" style="display:inline" onsubmit="return confirm('למחוק?')">
          <button class="btn btn-danger btn-sm">🗑️</button>
        </form>
      </td>
    </tr>`).join('')

    res.send(html('מטופלים', `
      <h1>מטופלים (${patients.length})</h1>
      <div class="card">
        <form method="GET">
          <input name="q" value="${query}" placeholder="חיפוש לפי שם או טלפון...">
        </form>
        <table>
          <thead><tr><th>שם</th><th>טלפון</th><th>מקור</th><th>פעולות</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">אין מטופלים</td></tr>'}</tbody>
        </table>
      </div>
      <a href="/patients/new" class="btn btn-primary">➕ מטופל חדש</a>
    `))
  })

  app.get('/patients/new', (req, res) => {
    res.send(html('מטופל חדש', `
      <h1>הוספת מטופל חדש</h1>
      <div class="card">
        <form method="POST" action="/patients">
          <label>שם משפחה *</label>
          <input name="nom" required>
          <label>שם פרטי</label>
          <input name="prenom">
          <label>טלפון * (050X או +972...)</label>
          <input name="telephone" required placeholder="0501234567">
          <label>הערות</label>
          <textarea name="notes" rows="3"></textarea>
          <button class="btn btn-primary" type="submit">שמור</button>
          <a href="/patients" class="btn btn-sm" style="background:#ccc;color:#333;margin-right:8px">ביטול</a>
        </form>
      </div>
    `))
  })

  app.post('/patients', (req, res) => {
    const { nom, prenom, telephone, notes } = req.body
    try {
      upsertPatient({ nom, prenom, telephone, notes, source: 'manual' })
      invalidateIndex()
      res.redirect('/patients?success=1')
    } catch (err) {
      res.send(html('שגיאה', `<div class="card"><p class="alert alert-error">שגיאה: ${err.message}</p><a href="/patients/new">חזור</a></div>`))
    }
  })

  app.get('/patients/:id/edit', (req, res) => {
    const patients = getAllPatients()
    const p = patients.find(x => x.id == req.params.id)
    if (!p) return res.redirect('/patients')

    res.send(html('עריכת מטופל', `
      <h1>עריכת מטופל</h1>
      <div class="card">
        <form method="POST" action="/patients/${p.id}/edit">
          <label>שם משפחה *</label>
          <input name="nom" value="${p.nom}" required>
          <label>שם פרטי</label>
          <input name="prenom" value="${p.prenom || ''}">
          <label>טלפון *</label>
          <input name="telephone" value="${p.telephone}" required>
          <label>הערות</label>
          <textarea name="notes" rows="3">${p.notes || ''}</textarea>
          <button class="btn btn-primary" type="submit">שמור</button>
          <a href="/patients" class="btn btn-sm" style="background:#ccc;color:#333;margin-right:8px">ביטול</a>
        </form>
      </div>
    `))
  })

  app.post('/patients/:id/edit', (req, res) => {
    const { nom, prenom, telephone, notes } = req.body
    try {
      upsertPatient({ nom, prenom, telephone, notes, source: 'manual' })
      invalidateIndex()
      res.redirect('/patients')
    } catch (err) {
      res.redirect('/patients')
    }
  })

  app.post('/patients/:id/delete', (req, res) => {
    deletePatient(req.params.id)
    res.redirect('/patients')
  })

  // ── Logs ──────────────────────────────────────────────────────────
  app.get('/logs', (req, res) => {
    const rappels = getRecentRappels(100)
    const syncs = getRecentSyncLogs(30)

    const rappelRows = rappels.map(r => {
      const cls = r.statut === 'envoye' ? 'ok' : r.statut === 'echec' ? 'err' : 'warn'
      const date = r.event_start ? new Date(r.event_start).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—'
      const sent = r.sent_at ? new Date(r.sent_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—'
      return `<tr>
        <td>${r.event_titre || '—'}</td>
        <td>${r.patient_telephone || '—'}</td>
        <td>${date}</td>
        <td><span class="status ${cls}">${r.statut}</span></td>
        <td>${sent}</td>
      </tr>`
    }).join('')

    const syncRows = syncs.map(s => {
      const cls = s.statut === 'ok' ? 'ok' : 'err'
      const date = new Date(s.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
      return `<tr><td>${s.type}</td><td><span class="status ${cls}">${s.statut}</span></td><td>${date}</td><td>${s.details || ''}</td></tr>`
    }).join('')

    res.send(html('לוגים', `
      <h1>לוגים</h1>
      <div class="card">
        <h2>תזכורות</h2>
        <table>
          <thead><tr><th>תור</th><th>טלפון</th><th>תאריך תור</th><th>סטטוס</th><th>נשלח</th></tr></thead>
          <tbody>${rappelRows || '<tr><td colspan="5">אין רשומות</td></tr>'}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>סנכרון</h2>
        <table>
          <thead><tr><th>סוג</th><th>סטטוס</th><th>תאריך</th><th>פרטים</th></tr></thead>
          <tbody>${syncRows || '<tr><td colspan="4">אין רשומות</td></tr>'}</tbody>
        </table>
      </div>
    `))
  })

  // ── Settings / Google Auth ─────────────────────────────────────────
  app.get('/settings', (req, res) => {
    const gcalOk = isAuthenticated()
    res.send(html('הגדרות', `
      <h1>הגדרות</h1>
      <div class="card">
        <h2>Google Calendar</h2>
        ${gcalOk
          ? '<p class="alert alert-success">✓ מחובר ל-Google Calendar</p>'
          : `<p>יש לאשר גישה ל-Google Calendar:</p><br>
             <a href="/auth/google" class="btn btn-primary">🔗 חיבור Google Calendar</a>`
        }
      </div>
      <div class="card">
        <h2>WhatsApp</h2>
        <p>סטטוס: <span class="status ${isConnected() ? 'ok' : 'err'}">${isConnected() ? 'מחובר ✓' : 'מנותק — הפעל מחדש את השרת לסריקת QR'}</span></p>
      </div>
    `))
  })

  app.get('/auth/google', (req, res) => {
    res.redirect(getAuthUrl())
  })

  app.get('/auth/google/callback', async (req, res) => {
    try {
      await saveToken(req.query.code)
      res.redirect('/settings')
    } catch (err) {
      res.send(html('שגיאה', `<div class="card"><p class="alert alert-error">שגיאה: ${err.message}</p></div>`))
    }
  })

  // ── Actions manuelles ─────────────────────────────────────────────
  app.post('/actions/sync-icloud', async (req, res) => {
    syncContacts().catch(err => logger.error({ err }, 'sync icloud manual'))
    res.redirect('/?action=syncing')
  })

  app.post('/actions/sync-calendar', async (req, res) => {
    pollAndEnrich().catch(err => logger.error({ err }, 'calendar manual'))
    res.redirect('/?action=syncing')
  })

  app.post('/actions/send-reminders', async (req, res) => {
    const { sendReminders } = require('./reminders')
    sendReminders().catch(err => logger.error({ err }, 'reminders manual'))
    res.redirect('/?action=sending')
  })

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Interface web disponible sur http://192.168.1.174:${PORT}`)
  })
}

module.exports = { start }
