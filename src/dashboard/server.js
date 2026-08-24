// src/dashboard/server.js
// Los proces van de bot zelf (zelfde SQLite-bestand, alleen lezend hier).
// Login via Discord OAuth2, toegang beperkt tot user-ID's in
// DASHBOARD_ALLOWED_USER_IDS. Geen wachtwoorden om te lekken, geen aparte
// user-database — je eigen Discord-account IS de sleutel.

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const Database = require('better-sqlite3');

const {
  DASHBOARD_PORT = 3001,
  SESSION_SECRET,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,
  DASHBOARD_ALLOWED_USER_IDS = '',
  DASHBOARD_IP_WHITELIST = '',
  DB_PATH = './data/guardian.sqlite',
} = process.env;

const allowedIds = DASHBOARD_ALLOWED_USER_IDS.split(',').map(s => s.trim()).filter(Boolean);

// --- IP whitelist ---
// Comma-gescheiden lijst van toegestane IP's of CIDR-ranges, bv.
// "82.171.x.x,192.168.1.0/24". Leeg = geen IP-restrictie (alleen Discord-
// login beschermt dan nog). Sterk aanbevolen om dit wel te vullen —
// dit is de allereerste check, vóór er zelfs maar een login-scherm
// getoond wordt.
const ipWhitelist = DASHBOARD_IP_WHITELIST.split(',').map(s => s.trim()).filter(Boolean);

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpAllowed(reqIp) {
  if (ipWhitelist.length === 0) return true; // geen whitelist ingesteld = niet blokkeren op IP
  // Express achter een reverse proxy geeft soms "::ffff:1.2.3.4" — normaliseren
  const ip = reqIp.replace('::ffff:', '');

  return ipWhitelist.some(entry => {
    if (entry.includes('/')) {
      const [range, bits] = entry.split('/');
      const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
      try {
        return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
      } catch {
        return false;
      }
    }
    return entry === ip;
  });
}

function ipGate(req, res, next) {
  if (isIpAllowed(req.ip)) return next();
  console.warn(`[Guardian Dashboard] Geweigerd IP buiten whitelist: ${req.ip} (${req.method} ${req.path})`);
  try {
    // Los, kort schrijfmoment op dezelfde database — de bot zelf blijft de
    // hoofdschrijver, dit is puur voor zichtbaarheid van geweigerde pogingen.
    const writeDb = new Database(DB_PATH);
    writeDb.prepare(`
      INSERT INTO events (type, detail, severity, created_at) VALUES (?, ?, ?, ?)
    `).run('dashboard_ip_blocked', JSON.stringify({ ip: req.ip, path: req.path }), 'warning', Date.now());
    writeDb.close();
  } catch (err) {
    // Als de database nog niet bestaat (bot nog niet gestart), gewoon negeren
  }
  return res.status(403).send('Toegang geweigerd: dit IP-adres staat niet op de whitelist.');
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: false });

const app = express();
// Nodig als de dashboard achter Pterodactyl's/je eigen reverse proxy draait,
// zodat req.ip het echte client-IP is i.p.v. het interne proxy-IP.
app.set('trust proxy', true);
app.use(ipGate); // IP-check gebeurt VOORDAT er zelfs een sessie/login-pagina wordt getoond

app.use(session({
  secret: SESSION_SECRET || 'change-me-in-.env',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 },
}));

function requireAuth(req, res, next) {
  if (req.session.user && allowedIds.includes(req.session.user.id)) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&response_type=code&scope=identify`;
  res.send(`<a href="${url}" style="font-family:sans-serif">Inloggen met Discord</a>`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Geen code ontvangen.');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(401).send('Login mislukt.');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    if (!allowedIds.includes(user.id)) {
      return res.status(403).send('Je account staat niet op de toegestane lijst voor dit dashboard.');
    }

    req.session.user = { id: user.id, username: user.username };
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Er ging iets mis bij het inloggen.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Read-only API voor het dashboard ---

app.get('/api/events', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const rows = db.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`).all(limit);
  res.json(rows);
});

app.get('/api/events/critical', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM events WHERE severity = 'critical' ORDER BY created_at DESC LIMIT 100`).all();
  res.json(rows);
});

app.get('/api/stats', requireAuth, (req, res) => {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const totals = db.prepare(`
    SELECT type, COUNT(*) as count FROM events WHERE created_at >= ? GROUP BY type ORDER BY count DESC
  `).all(dayAgo);
  res.json({ since: dayAgo, totals });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(DASHBOARD_PORT, () => {
  console.log(`RIVINS Guardian dashboard op poort ${DASHBOARD_PORT}`);
});
