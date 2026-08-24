// src/modules/adminAbuseDetection.js
//
// Kern van het systeem: bewaakt de Discord Audit Log zelf op patronen die wijzen
// op een gecompromitteerd staff/admin-account of misbruik van rechten — precies
// het handwerk dat op 24 augustus 2026 handmatig moest gebeuren (audit log
// doorpluizen na de DeathWish-raid, webhook-aanmaak-anomalie natrekken).
//
// Belangrijk ontwerpprincipe ("geen backdoors"): dit is de ENIGE plek die
// destructieve automatische acties kan nemen (rol afpakken bij alarm), en
// dat gebeurt alleen als STRICT_MODE=true expliciet aan staat. Standaard
// doet dit systeem alleen: loggen + alarmeren. Geen stille achterdeur, geen
// enkel account dat buiten deze logica om iets kan — inclusief de eigenaar
// (OWNER_ID) niet, die is alleen uitgezonderd van de protection-thresholds,
// niet van de logging zelf.

const { AuditLogEvent } = require('discord.js');
const { trackAction, countRecentActions, logEvent, getSetting } = require('../db');
const { buildEmbed } = require('./logging');

const CONFIG = {
  POLL_INTERVAL_MS: 15000,
  // drempels: X van deze actie door dezelfde actor binnen Y ms = alarm
  THRESHOLDS: {
    [AuditLogEvent.MemberBanAdd]:        { limit: 5,  windowMs: 60000 },
    [AuditLogEvent.MemberKick]:          { limit: 5,  windowMs: 60000 },
    [AuditLogEvent.ChannelDelete]:       { limit: 3,  windowMs: 60000 },
    [AuditLogEvent.RoleDelete]:          { limit: 3,  windowMs: 60000 },
    [AuditLogEvent.WebhookCreate]:       { limit: 5,  windowMs: 120000 }, // zie 24 aug: 67 webhooks totaal, spikes zijn verdacht
    [AuditLogEvent.BotAdd]:              { limit: 2,  windowMs: 300000 },
    [AuditLogEvent.MemberRoleUpdate]:    { limit: 10, windowMs: 60000 }, // mass role-toekenning
  },
};

let lastSeenAuditId = null;

async function pollAuditLog(guild, { ownerId, alertChannelId, strictMode = false }) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 25 });
    const entries = [...logs.entries.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const entry of entries) {
      if (lastSeenAuditId && entry.id <= lastSeenAuditId) continue;

      const actorId = entry.executorId;
      if (!actorId || actorId === guild.client.user.id) continue; // eigen bot-acties niet als "admin abuse" tellen

      const threshold = CONFIG.THRESHOLDS[entry.action];
      if (!threshold) continue;

      const key = `audit:${actorId}:${entry.action}`;
      trackAction(key, 'audit_action');
      const recent = countRecentActions(key, 'audit_action', threshold.windowMs);

      if (recent >= threshold.limit) {
        const isOwner = actorId === ownerId;
        logEvent({
          type: 'admin_abuse_alert',
          actorId,
          detail: {
            action: AuditLogEvent[entry.action] ?? entry.action,
            recent,
            windowMs: threshold.windowMs,
            isOwner,
            reason: entry.reason,
          },
          severity: 'critical',
        });

        const alertChannel = guild.channels.cache.get(alertChannelId);
        if (alertChannel) {
          await alertChannel.send({
            content: isOwner ? null : `⚠️ <@${actorId}> — mogelijk misbruik gedetecteerd`,
            embeds: [buildEmbed('🚨 Verdacht admin-gedrag gedetecteerd', [
              { name: 'Actie', value: `${AuditLogEvent[entry.action] ?? entry.action}`, inline: true },
              { name: 'Door', value: `<@${actorId}>${isOwner ? ' (owner — check of dit bewust was)' : ''}`, inline: true },
              { name: 'Aantal', value: `${recent}x binnen ${Math.round(threshold.windowMs / 1000)}s`, inline: true },
              { name: 'Reden (indien opgegeven)', value: entry.reason || '*(geen reden opgegeven)*' },
            ], 'critical')],
          }).catch(() => {});
        }

        // Strict mode: alleen als expliciet aangezet, en NOOIT op de owner zelf.
        // Dit is de enige plek waar het systeem zelf ingrijpt — bewust beperkt.
        if (strictMode && !isOwner) {
          await quarantineActor(guild, actorId).catch(() => {});
        }
      }
    }

    if (entries.length > 0) lastSeenAuditId = entries[entries.length - 1].id;
  } catch (err) {
    logEvent({ type: 'admin_abuse_poll_error', detail: { message: err.message }, severity: 'warning' });
  }
}

// Tijdelijke quarantaine: haalt gevaarlijke rollen weg (niet: bannen/kicken —
// dat besluit blijft bewust bij een mens). Alleen actief in strict mode.
async function quarantineActor(guild, actorId) {
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return;

  const dangerousRoles = member.roles.cache.filter(r =>
    r.permissions.has('Administrator') ||
    r.permissions.has('BanMembers') ||
    r.permissions.has('ManageWebhooks') ||
    r.permissions.has('ManageRoles')
  );

  if (dangerousRoles.size === 0) return;

  await member.roles.remove(dangerousRoles, 'RIVINS Guardian — automatische quarantaine na verdacht patroon (strict mode)');
  logEvent({
    type: 'admin_abuse_quarantine',
    actorId,
    detail: { removedRoles: dangerousRoles.map(r => r.name) },
    severity: 'critical',
  });
}

function startAdminAbuseWatcher(client, guildId, { ownerId, alertChannelId, strictMode }) {
  setInterval(async () => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) await pollAuditLog(guild, { ownerId, alertChannelId, strictMode });
  }, CONFIG.POLL_INTERVAL_MS);
}

module.exports = { startAdminAbuseWatcher, pollAuditLog, CONFIG };
