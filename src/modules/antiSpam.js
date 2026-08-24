// src/modules/antiSpam.js
// Detecteert: bericht-flooding, herhaalde/identieke berichten, mass-mentions,
// en spam-achtige externe-invite-links (precies het patroon van de
// "JOIN DeathWish TO START RAIDING..."-berichten van 24 aug).

const { trackAction, countRecentActions, logEvent } = require('../db');

const CONFIG = {
  MESSAGE_LIMIT: 5,        // max berichten...
  MESSAGE_WINDOW_MS: 4000, // ...binnen dit venster
  DUPLICATE_LIMIT: 3,      // max identieke opeenvolgende berichten
  MENTION_LIMIT: 6,        // max @mentions in één bericht
  INVITE_REGEX: /(discord\.gg|discord\.com\/invite)\/[a-z0-9-]+/i,
};

// Houdt de laatste berichttekst per user bij voor duplicate-detectie (in-memory, licht)
const lastMessages = new Map(); // userId -> { text, count }

function isExempt(member, exemptRoleIds) {
  if (!member) return false;
  if (member.permissions?.has('Administrator')) return true;
  return member.roles.cache.some(r => exemptRoleIds.includes(r.id));
}

async function handleMessage(message, { exemptRoleIds = [], onViolation }) {
  if (message.author.bot && !message.webhookId) return; // eigen bots negeren, webhooks WEL checken (zie hieronder)
  if (message.member && isExempt(message.member, exemptRoleIds)) return;

  const authorId = message.webhookId ? `webhook:${message.webhookId}` : message.author.id;
  const violations = [];

  // 1. Bericht-flooding
  trackAction(authorId, 'message');
  const recent = countRecentActions(authorId, 'message', CONFIG.MESSAGE_WINDOW_MS);
  if (recent > CONFIG.MESSAGE_LIMIT) {
    violations.push(`Message flooding: ${recent} berichten in ${CONFIG.MESSAGE_WINDOW_MS}ms`);
  }

  // 2. Duplicate/herhaalde berichten (precies het "JOIN DeathWish..." x12-patroon)
  const prev = lastMessages.get(authorId);
  if (prev && prev.text === message.content && message.content.length > 0) {
    prev.count += 1;
    if (prev.count >= CONFIG.DUPLICATE_LIMIT) {
      violations.push(`Herhaald identiek bericht ${prev.count}x`);
    }
  } else {
    lastMessages.set(authorId, { text: message.content, count: 1 });
  }

  // 3. Mass mentions
  const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
  if (mentionCount > CONFIG.MENTION_LIMIT) {
    violations.push(`Mass mention: ${mentionCount} mentions in één bericht`);
  }

  // 4. Externe Discord-invite in combinatie met @everyone/@here — het exacte DeathWish-patroon
  if (CONFIG.INVITE_REGEX.test(message.content) && (message.mentions.everyone)) {
    violations.push(`Externe Discord-invite gecombineerd met @everyone/@here`);
  }

  if (violations.length > 0) {
    logEvent({
      type: 'antispam_violation',
      actorId: authorId,
      channelId: message.channel.id,
      detail: { violations, content: message.content.slice(0, 500) },
      severity: 'warning',
    });
    if (onViolation) await onViolation(message, violations);
  }
}

module.exports = { handleMessage, CONFIG };
