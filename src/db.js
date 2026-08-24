// src/db.js
// Local SQLite storage. One file, no separate database service, no extra
// network port to lock down. Matches the same philosophy as armastatus.php
// (flat local data instead of an external database).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/guardian.sqlite';

// Make sure the data directory exists (Pterodactyl persistent volume)
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
      actor_id TEXT,
        target_id TEXT,
          channel_id TEXT,
            detail TEXT,
              severity TEXT DEFAULT 'info',
                created_at INTEGER NOT NULL
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
                        kind TEXT NOT NULL,
                          ts INTEGER NOT NULL
                          );
                          CREATE INDEX IF NOT EXISTS idx_rate_user_kind ON rate_tracking(user_id, kind, ts);

                          CREATE TABLE IF NOT EXISTS warns (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                              user_id TEXT NOT NULL,
                                moderator_id TEXT NOT NULL,
                                  reason TEXT,
                                    created_at INTEGER NOT NULL,
                                      active INTEGER NOT NULL DEFAULT 1
                                      );
                                      CREATE INDEX IF NOT EXISTS idx_warns_user ON warns(user_id);
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

function countRecentActions(userId, kind, windowMs) {
    const since = Date.now() - windowMs;
    const row = db.prepare(`
        SELECT COUNT(*) AS c FROM rate_tracking WHERE user_id = ? AND kind = ? AND ts >= ?
          `).get(userId, kind, since);
    return row.c;
}

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

function addWarn(userId, moderatorId, reason) {
    const info = db.prepare(`
        INSERT INTO warns (user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?)
          `).run(userId, moderatorId, reason, Date.now());
    return info.lastInsertRowid;
}

function getWarns(userId, activeOnly = true) {
    const query = activeOnly
      ? `SELECT * FROM warns WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`
          : `SELECT * FROM warns WHERE user_id = ? ORDER BY created_at DESC`;
    return db.prepare(query).all(userId);
}

function deactivateWarn(warnId) {
    const info = db.prepare(`UPDATE warns SET active = 0 WHERE id = ?`).run(warnId);
    return info.changes > 0;
}

module.exports = {
    db,
    logEvent,
    trackAction,
    countRecentActions,
    pruneRateTracking,
    getSetting,
    setSetting,
    addWarn,
    getWarns,
    deactivateWarn,
};
