// src/db.js
// Lokale SQLite-opslag. Eén bestand, geen losse database-service, geen extra
// netwerk-poort die je moet afschermen. Past bij hoe armastatus.php werkt
// (platte lokale data i.p.v. een externe database).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/guardian.sqlite';

// Zorg dat de data-map bestaat (Pterodactyl persistente volume)
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- bv. 'message_delete', 'member_ban', 'admin_abuse_alert'
  actor_id TEXT,                   -- wie de actie uitvoerde (kan NULL zijn, bv. bij spam door de auteur zelf)
  target_id TEXT,                  -- op wie/wat de actie van toepassing was
  channel_id TEXT,
  detail TEXT,                     -- vrije tekst / JSON-blob met context
  severity TEXT DEFAULT 'info',    -- info | warning | critical
  created_at INTEGER NOT NULL      -- unix timestamp (ms)
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_tracking (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'message' | 'join' | 'ban' | 'kick' | 'webhook_create' | ...
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_user_kind ON rate_tracking(user_id, kind, ts);
`);

function logEvent({ type, actorId = null, targetId = null, channelId = null, detail = null, severity = 'info' }) {
  db.prepare(`
    INSERT INTO events (type, actor_id, target_id, channel_id, detail, severity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(type, actorId, targetId, channelId, detail ? JSON.stringify(detail) : null, severity, Date.now());
}

function trackAction(userId, kind) {
  db.prepare(`INSERT INTO rate_tracking (user_id, kind, ts) VALUES (?, ?, ?)`).run(userId, kind, Date.now());
}

// Hoeveel acties van dit type heeft deze user gedaan in de laatste `windowMs` ms?
function countRecentActions(userId, kind, windowMs) {
  const since = Date.now() - windowMs;
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM rate_tracking WHERE user_id = ? AND kind = ? AND ts >= ?
  `).get(userId, kind, since);
  return row.c;
}

// Opruimen van oude rate-tracking-rijen (voorkomt dat de tabel oneindig groeit)
function pruneRateTracking(olderThanMs = 24 * 60 * 60 * 1000) {
  db.prepare(`DELETE FROM rate_tracking WHERE ts < ?`).run(Date.now() - olderThanMs);
}

function getSetting(key, fallback = null) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

module.exports = {
  db,
  logEvent,
  trackAction,
  countRecentActions,
  pruneRateTracking,
  getSetting,
  setSetting,
};
