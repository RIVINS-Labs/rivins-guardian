// src/modules/timeoutProtection.js
//
// Grijpt zelf in: als iemand (staff of een gecompromitteerd account) te veel
// timeouts uitdeelt in korte tijd, wordt de laatst-uitgedeelde timeout
// teruggedraaid EN verliest de actor tijdelijk zijn timeout-bevoegdheid
// (rollen met Moderate Members worden afgepakt). Discord's guildMemberUpdate
// geeft niet direct WIE de timeout zette — dat halen we uit de audit log.
//
// De owner (OWNER_ID) is uitgezonderd van de actie (maar niet van logging),
// zelfde principe als adminAbuseDetection.js.

const { AuditLogEvent } = require('discord.js');
const { trackAction, countRecentActions, logEvent } = require('../db');
const { buildEmbed } = require('./logging');

const CONFIG = {
  LIMIT: 3,          // meer dan dit aantal timeouts...
  WINDOW_MS: 60000,  // ...binnen dit venster is verdacht
};

async function handleGuildMemberUpdate(oldMember, newMember, { ownerId, alertChannelId }) {
  const wasTimedOut = oldMember.communicationDisabledUntilTimestamp && oldMember.communicationDisabledUntilTimestamp > Date.now();
  const isTimedOut = newMember.communicationDisabledUntilTimestamp && newMember.communicationDisabledUntilTimestamp > Date.now();

  // Alleen reageren op het MOMENT dat een timeout wordt ingesteld (niet op elke update)
  if (wasTimedOut || !isTimedOut) return;

  const guild = newMember.guild;
  const client = guild.client;

  // Wie deed dit? Kijk in de audit log naar de meest recente MemberUpdate op dit lid.
  let actorId = null;
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
    const entry = logs.entries.find(e => e.target?.id === newMember.id && Date.now() - e.createdTimestamp < 10000);
    actorId = entry?.executorId ?? null;
  } catch {
    // audit log niet beschikbaar (rechten?) — dan kunnen we niet reageren
  }

  if (!actorId || actorId === client.user.id) return; // eigen acties (bv. via /timeout-commando hieronder) niet tegen jezelf tellen

  trackAction(`timeout:${actorId}`, 'timeout_issued');
  const recent = countRecentActions(`timeout:${actorId}`, 'timeout_issued', CONFIG.WINDOW_MS);

  logEvent({
    type: 'timeout_issued',
    actorId,
    targetId: newMember.id,
    severity: recent >= CONFIG.LIMIT ? 'critical' : 'info',
  });

  if (recent < CONFIG.LIMIT) return; // binnen normale grenzen, geen actie

  const isOwner = actorId === ownerId;
  const alertChannel = client.channels.cache.get(alertChannelId);

  // 1. Draai deze specifieke timeout terug
  let reverted = false;
  try {
    await newMember.timeout(null, 'RIVINS Guardian — teruggedraaid: te veel timeouts door dezelfde persoon in korte tijd');
    reverted = true;
  } catch (err) {
    logEvent({ type: 'timeout_protection_revert_failed', targetId: newMember.id, detail: { error: err.message }, severity: 'critical' });
  }

  // 2. Owner wordt nooit van rollen ontdaan, alleen gealarmeerd
  let strippedRoles = [];
  if (!isOwner) {
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (actor) {
      const rolesWithTimeout = actor.roles.cache.filter(r => r.permissions.has('ModerateMembers'));
      if (rolesWithTimeout.size > 0) {
        try {
          await actor.roles.remove(rolesWithTimeout, 'RIVINS Guardian — automatisch afgepakt: mogelijk misbruik van timeout-functie');
          strippedRoles = rolesWithTimeout.map(r => r.name);
        } catch (err) {
          logEvent({ type: 'timeout_protection_strip_failed', actorId, detail: { error: err.message }, severity: 'critical' });
        }
      }
    }
  }

  logEvent({
    type: 'timeout_protection_triggered',
    actorId,
    targetId: newMember.id,
    detail: { recent, reverted, strippedRoles, isOwner },
    severity: 'critical',
  });

  if (alertChannel) {
    await alertChannel.send({
      content: isOwner ? null : `⚠️ <@${actorId}> — automatisch ingegrepen wegens verdacht timeout-gebruik`,
      embeds: [buildEmbed('🛑 Timeout Protection geactiveerd', [
        { name: 'Door', value: `<@${actorId}>${isOwner ? ' (owner)' : ''}`, inline: true },
        { name: 'Aantal', value: `${recent}x binnen ${Math.round(CONFIG.WINDOW_MS / 1000)}s`, inline: true },
        { name: 'Laatste timeout teruggedraaid?', value: reverted ? 'Ja' : 'Mislukt — handmatig checken', inline: true },
        { name: 'Rollen afgepakt', value: isOwner ? 'Nee (owner uitgezonderd)' : (strippedRoles.length ? strippedRoles.join(', ') : 'Geen (had geen ModerateMembers-rol)') },
      ], 'critical')],
    }).catch(() => {});
  }
}

module.exports = { handleGuildMemberUpdate, CONFIG };
