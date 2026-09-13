// src/modules/ingameRelay.js
// Discord -> Arma Reforger in-game announcements.
//
// Staff type in one Discord channel; every RIVINSlive Arma server shows the text
// on screen within a few seconds. A Reforger server cannot receive a push, so it
// polls: the "RIVINS Discord Relay" mod asks GET /relay/<server>?after=<id> every
// few seconds and this module answers with whatever is new.
//
// Message format in the channel:
//   text              -> every server, 15 seconds
//   30 text           -> every server, 30 seconds
//   flight: text      -> only the server whose relay key is "flight"
//   flight: 30 text   -> both
//   event: text       -> a panel that STAYS on screen on every server
//   flight event: txt -> the same, only on that server
//   event: clear      -> panel gone (also "flight event: clear")
//   center: text      -> big text in the middle of the screen, every server
//   flight center: 20 text -> the same on one server, 20 seconds
//
// The reply is plain text, not JSON, on purpose: the game's script language parses
// a line split in a handful of instructions, a JSON reader is a lot more code.
//   last=<id>
//   event=<id>\t<text>          (empty text = no panel)
//   <id>\t<seconds>\t<text>       (seconds prefixed with "c" = middle of the screen)
//
// Nothing here is secret: announcements are shown to every player anyway. The
// only thing that must be protected is WHO can post, and that is enforced on the
// Discord side (channel permissions + the role check below). RELAY_KEY is an
// optional extra: if set, a server must send ?k=<key>.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHANNEL_ID = process.env.RELAY_CHANNEL_ID || '1548409512023691344';           // #ingame-announcements
const ROLE_IDS = (process.env.RELAY_ROLE_IDS || '1479967956598390947')              // ARMA Moderators
  .split(',').map((s) => s.trim()).filter(Boolean);
const PORT = parseInt(process.env.RELAY_PORT || process.env.SERVER_PORT || '0', 10);
const RELAY_KEY = process.env.RELAY_KEY || '';

const KEEP_MS = 5 * 60 * 1000;      // a server that was offline longer than this does not replay old text
const CHECK_AFTER_MS = 20 * 1000;   // when the bot reports back in Discord who showed it
const MAX_TEXT = 300;

// Arma -> Discord staff log (13 Sep 2026): kill reports, strikes, civilian kills, jail.
// The RIVINS flight school mod POSTs "type<TAB>text" to /arma-log/<server>?k=<key>.
// Unlike the relay this endpoint WRITES into Discord, so it needs a key. It lives in
// data/arma_log_key.txt (created on first start, kept by entrypoint.sh, never in git)
// unless ARMA_LOG_KEY is set; the Arma servers carry the same key as "logkey=" in
// profile/RIVINS/discord_relay.txt.
const ARMA_LOG_CHANNEL_ID = process.env.ARMA_LOG_CHANNEL_ID || '1548769072789852250'; // #arma-jail-log
const ARMA_LOG_KEY_FILE = path.join(path.dirname(process.env.DB_PATH || './data/guardian.sqlite'), 'arma_log_key.txt');
let ARMA_LOG_KEY = process.env.ARMA_LOG_KEY || '';
if (!ARMA_LOG_KEY) {
  try { ARMA_LOG_KEY = fs.readFileSync(ARMA_LOG_KEY_FILE, 'utf8').trim(); } catch (_) { ARMA_LOG_KEY = ''; }
  if (!ARMA_LOG_KEY) {
    ARMA_LOG_KEY = crypto.randomBytes(18).toString('hex');
    try { fs.writeFileSync(ARMA_LOG_KEY_FILE, ARMA_LOG_KEY); } catch (err) { console.error('[Relay] Could not save arma log key:', err.message); }
  }
}
const ARMA_LOG_PER_MIN = 30;
const armaLogCount = new Map();     // server key -> { minute, count }
const ARMA_LOG_STYLE = {
  report: { color: 0xe67e22, title: 'Kill reported as unfair' },
  fair: { color: 0x95a5a6, title: 'Kill confirmed fair' },
  strike: { color: 0xf1c40f, title: 'Strike' },
  civ: { color: 0xe74c3c, title: 'Civilian killed' },
  jail: { color: 0xc0392b, title: 'Sent to jail' },
  release: { color: 0x2ecc71, title: 'Released from jail' },
  mission: { color: 0x3498db, title: 'Mission' },
};

// The event panel survives a bot restart: data/ is kept by entrypoint.sh.
const EVENT_FILE = path.join(path.dirname(process.env.DB_PATH || './data/guardian.sqlite'), 'relay_events.json');
let events = {};                    // target ("all" or a server key) -> { id, text }
try { events = JSON.parse(fs.readFileSync(EVENT_FILE, 'utf8')); } catch (_) { events = {}; }

function saveEvents() {
  try { fs.writeFileSync(EVENT_FILE, JSON.stringify(events)); } catch (err) { console.error('[Relay] Could not save events:', err.message); }
}

// The panel a server should show: the newest of "all" and its own.
function eventFor(key) {
  const a = events.all;
  const s = events[key];
  if (a && s) return a.id > s.id ? a : s;
  return a || s || { id: 0, text: '' };
}

const items = [];                   // { id, at, target, seconds, text, seenBy:Set }
const lastPoll = new Map();         // server key -> timestamp
// Start at "now", never at 0. A game server that just started asks after=0 and
// only remembers the number it gets back; if that number were 0 it would keep
// asking after=0, which by design shows nothing, and never see a message.
let lastId = (Math.floor(Date.now() / 1000) - 1700000000) * 10;

function nextId() {
  // Time-based, so the numbers keep rising across a bot restart and a server
  // that remembered "after=<old id>" still gets new messages.
  // Tenths of a second since 2023-11-14, NOT Date.now(): the game's script int is
  // 32-bit (max 2 147 483 647). Milliseconds since 1970 would overflow it; this
  // stays below that limit until the year 2030.
  lastId = Math.max(lastId + 1, (Math.floor(Date.now() / 1000) - 1700000000) * 10);
  return lastId;
}

function clean(text) {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, MAX_TEXT);
}

function parse(content) {
  let text = content.trim();
  let target = 'all';
  let seconds = 15;

  // "word: text" only counts as a server prefix when that word is a server that
  // has actually checked in (or "all"). Otherwise "Note: restart at 20:00" would
  // silently go nowhere, and "12:30 event" would target a server called "12".
  const t = text.match(/^([a-z][a-z0-9_-]{1,19}):\s*([\s\S]+)$/i);
  if (t && (t[1].toLowerCase() === 'all' || lastPoll.has(t[1].toLowerCase()))) {
    target = t[1].toLowerCase();
    text = t[2];
  }

  // A leading number is a duration only between 5 and 120, so "2 players online"
  // stays a sentence.
  const s = text.match(/^(\d{1,3})\s+([\s\S]+)$/);
  if (s && parseInt(s[1], 10) >= 5 && parseInt(s[1], 10) <= 120) {
    seconds = parseInt(s[1], 10);
    text = s[2];
  }

  return { target, seconds, text: clean(text) };
}

function mayPost(message, ownerId) {
  if (message.author.bot) return false;
  if (ownerId && message.author.id === ownerId) return true;
  const roles = message.member?.roles?.cache;
  return !!roles && ROLE_IDS.some((id) => roles.has(id));
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  while (items.length && items[0].at < cutoff) items.shift();
}

async function postArmaLog(client, server, body) {
  const tab = body.indexOf('\t');
  const type = (tab > 0 ? body.slice(0, tab) : 'info').trim().toLowerCase().slice(0, 20);
  const text = clean(tab > 0 ? body.slice(tab + 1) : body).slice(0, 1000);
  if (!text) return false;

  const now = Math.floor(Date.now() / 60000);
  const c = armaLogCount.get(server) || { minute: now, count: 0 };
  if (c.minute !== now) { c.minute = now; c.count = 0; }
  if (++c.count > ARMA_LOG_PER_MIN) { armaLogCount.set(server, c); return false; }
  armaLogCount.set(server, c);

  const style = ARMA_LOG_STYLE[type] || { color: 0x7f8c8d, title: type };
  const channel = await client.channels.fetch(ARMA_LOG_CHANNEL_ID).catch(() => null);
  if (!channel) return false;
  await channel.send({
    embeds: [{ color: style.color, title: style.title, description: text, footer: { text: `Arma server: ${server}` }, timestamp: new Date().toISOString() }],
    allowedMentions: { parse: [] },
  });
  return true;
}

function startHttp(client) {
  if (!PORT) {
    console.error('[Relay] No RELAY_PORT/SERVER_PORT - in-game relay HTTP endpoint NOT started.');
    return;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://relay');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };

    const lm = url.pathname.match(/^\/arma-log\/([a-z0-9_-]{2,20})$/i);
    if (lm) {
      if (req.method !== 'POST') return send(405, 'POST only');
      if (!ARMA_LOG_KEY || url.searchParams.get('k') !== ARMA_LOG_KEY) return send(403, 'forbidden');
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 4000) req.destroy(); });
      req.on('end', () => {
        postArmaLog(client, lm[1].toLowerCase(), body)
          .then((ok) => send(ok ? 200 : 429, ok ? 'ok' : 'dropped'))
          .catch((err) => { console.error('[Relay] arma-log failed:', err.message); send(500, 'error'); });
      });
      return;
    }

    if (req.method !== 'GET') return send(405, 'GET only');
    if (RELAY_KEY && url.searchParams.get('k') !== RELAY_KEY) return send(403, 'forbidden');

    if (url.pathname === '/relay-status') {
      const now = Date.now();
      const lines = [...lastPoll.entries()].map(([k, t]) => `${k}\t${Math.round((now - t) / 1000)}s ago`);
      return send(200, lines.join('\n') || 'no server has polled yet');
    }

    const m = url.pathname.match(/^\/relay\/([a-z0-9_-]{2,20})$/i);
    if (!m) return send(404, 'not found');

    const key = m[1].toLowerCase();
    const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
    lastPoll.set(key, Date.now());
    prune();

    const ev = eventFor(key);
    const out = [`last=${lastId}`, `event=${ev.id}\t${ev.text}`];
    // after=0 is a server that just started: tell it where we are, show nothing old.
    if (after > 0) {
      for (const it of items) {
        if (it.id <= after) continue;
        if (it.target !== 'all' && it.target !== key) continue;
        out.push(`${it.id}\t${it.seconds}\t${it.text}`);
        it.seenBy.add(key);
      }
    }
    return send(200, out.join('\n'));
  });

  server.on('error', (err) => console.error('[Relay] HTTP error:', err.message));
  server.listen(PORT, '0.0.0.0', () => console.log(`[Relay] In-game relay listening on port ${PORT}, channel ${CHANNEL_ID}`));
}

function registerIngameRelay(client, { ownerId } = {}) {
  startHttp(client);

  client.on('messageCreate', async (message) => {
    if (message.channelId !== CHANNEL_ID) return;
    if (!mayPost(message, ownerId)) return;

    const raw = (message.cleanContent || message.content || '').trim();

    // Event panel: "event: text" or "<server> event: text".
    const evm = raw.match(/^(?:([a-z][a-z0-9_-]{1,19})\s+)?event:\s*([\s\S]*)$/i);
    if (evm) {
      const target = (evm[1] || 'all').toLowerCase();
      let text = clean(evm[2] || '');
      if (/^(clear|off|none|remove)$/i.test(text)) text = '';
      // A panel for everyone replaces every server-specific one.
      if (target === 'all') events = {};
      events[target] = { id: nextId(), text };
      saveEvents();
      await message.react(text ? '📌' : '🧹').catch(() => {});
      const where = target === 'all' ? 'every server' : `**${target}**`;
      const clearCmd = target === 'all' ? 'event: clear' : `${target} event: clear`;
      await message.reply({
        content: text
          ? `Event panel on ${where}: "${text}" - stays until you type \`${clearCmd}\``
          : `Event panel removed on ${where}.`,
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
      return;
    }

    // Big text in the middle of the screen: "center: text" or "<server> center: [sec] text".
    const cm = raw.match(/^(?:([a-z][a-z0-9_-]{1,19})\s+)?(?:center|big):\s*([\s\S]+)$/i);
    if (cm) {
      const c = parse(cm[2]);
      const ctarget = (cm[1] || 'all').toLowerCase();
      if (!c.text) return;
      const cit = { id: nextId(), at: Date.now(), target: ctarget, seconds: 'c' + c.seconds, text: c.text, seenBy: new Set() };
      items.push(cit);
      prune();
      await message.react('📡').catch(() => {});
      setTimeout(async () => {
        const ok = cit.seenBy.size > 0;
        await message.react(ok ? '✅' : '⚠️').catch(() => {});
        await message.reply({
          content: ok ? `Shown in the middle of the screen on: **${[...cit.seenBy].join(', ')}** (${c.seconds}s)` : 'Not shown in-game - no matching server checked in.',
          allowedMentions: { repliedUser: false },
        }).catch(() => {});
      }, CHECK_AFTER_MS);
      return;
    }

    const { target, seconds, text } = parse(raw);
    if (!text) return;

    const it = { id: nextId(), at: Date.now(), target, seconds, text, seenBy: new Set() };
    items.push(it);
    prune();
    await message.react('📡').catch(() => {});

    setTimeout(async () => {
      const now = Date.now();
      const online = [...lastPoll.entries()].filter(([, t]) => now - t < 30000).map(([k]) => k);
      if (it.seenBy.size > 0) {
        await message.react('✅').catch(() => {});
        await message.reply({
          content: `Shown in-game on: **${[...it.seenBy].join(', ')}** (${seconds}s)`,
          allowedMentions: { repliedUser: false },
        }).catch(() => {});
      } else {
        await message.react('⚠️').catch(() => {});
        const hint = online.length
          ? `Servers online right now: ${online.join(', ')}. "${target}" matched none of them.`
          : 'No Arma server has checked in during the last 30 seconds - are the servers running the RIVINS Discord Relay mod?';
        await message.reply({ content: `Not shown in-game. ${hint}`, allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    }, CHECK_AFTER_MS);
  });
}

module.exports = { registerIngameRelay, parse };
