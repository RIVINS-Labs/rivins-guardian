// src/modules/antiRaid.js
// Detecteert: join-raids (te veel nieuwe leden te snel), heel jonge accounts,
// en — specifiek naar aanleiding van 24 aug — verdachte webhook-activiteit,
// aangezien "DeathWish" vermoedelijk via een misbruikte/gelekte webhook
// berichten postte, niet als echt lid.

const { trackAction, countRecentActions, logEvent } = require('../db');

const CONFIG = {
  JOIN_LIMIT: 8,
  JOIN_WINDOW_MS: 15000,
  MIN_ACCOUNT_AGE_MS: 24 * 60 * 60 * 1000, // 1 dag; zet hoger als je wil (bv. 7 dagen)
  WEBHOOK_MESSAGE_LIMIT: 5,     // hoeveel berichten van dezelfde webhook binnen het venster is verdacht
  WEBHOOK_WINDOW_MS: 10000,
};

async function handleGuildMemberAdd(member, { onRaidDetected }) {
  trackAction('__guild__', 'join');
  const recentJoins = countRecentActions('__guild__', 'join', CONFIG.JOIN_WINDOW_MS);

  const accountAge = Date.now() - member.user.createdTimestamp;
  const isNewAccount = accountAge < CONFIG.MIN_ACCOUNT_AGE_MS;

  if (isNewAccount) {
    logEvent({
      type: 'antiraid_new_account_join',
      actorId: member.id,
      detail: { accountAgeHours: Math.round(accountAge / 3600000) },
      severity: 'info',
    });
  }

  if (recentJoins > CONFIG.JOIN_LIMIT) {
    logEvent({
      type: 'antiraid_join_spike',
      detail: { recentJoins, windowMs: CONFIG.JOIN_WINDOW_MS },
      severity: 'critical',
    });
    if (onRaidDetected) await onRaidDetected(member.guild, recentJoins);
  }
}

// Elk bericht dat via een webhook binnenkomt loopt hierdoorheen (aparte functie,
// wordt aangeroepen vanuit antiSpam.handleMessage of los vanuit index.js)
async function checkWebhookActivity(message, { onSuspiciousWebhook }) {
  if (!message.webhookId) return;

  const key = `webhook:${message.webhookId}`;
  trackAction(key, 'webhook_message');
  const recent = countRecentActions(key, 'webhook_message', CONFIG.WEBHOOK_WINDOW_MS);

  if (recent > CONFIG.WEBHOOK_MESSAGE_LIMIT) {
    logEvent({
      type: 'antiraid_webhook_spike',
      actorId: key,
      channelId: message.channel.id,
      detail: {
        recent,
        windowMs: CONFIG.WEBHOOK_WINDOW_MS,
        authorName: message.author?.username,
        contentSample: message.content?.slice(0, 200),
      },
      severity: 'critical',
    });
    if (onSuspiciousWebhook) await onSuspiciousWebhook(message, recent);
  }
}

module.exports = { handleGuildMemberAdd, checkWebhookActivity, CONFIG };
