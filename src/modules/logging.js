// src/modules/logging.js
// Volledige audit-trail: message delete/edit, joins/leaves, bans/kicks/timeouts,
// rolwijzigingen. Slaat alles lokaal op (dashboard leest hieruit) én post
// een samenvatting naar het log-kanaal.

const { EmbedBuilder } = require('discord.js');
const { logEvent } = require('../db');

const COLORS = { info: 0x5865F2, warning: 0xF5A623, critical: 0xED4245 };

function buildEmbed(title, fields, severity = 'info') {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS[severity] ?? COLORS.info)
    .addFields(fields)
    .setTimestamp();
}

function registerLogging(client, logChannelId) {
  const getLogChannel = () => client.channels.cache.get(logChannelId);

  client.on('messageDelete', async (message) => {
    if (!message.guild) return;
    logEvent({
      type: 'message_delete',
      actorId: message.author?.id ?? message.webhookId ?? null,
      channelId: message.channel.id,
      detail: { content: message.content?.slice(0, 500) },
    });
    const ch = getLogChannel();
    if (ch && message.content) {
      ch.send({
        embeds: [buildEmbed('🗑️ Bericht verwijderd', [
          { name: 'Auteur', value: message.author ? `<@${message.author.id}>` : (message.webhookId ? 'Webhook' : 'Onbekend'), inline: true },
          { name: 'Kanaal', value: `<#${message.channel.id}>`, inline: true },
          { name: 'Inhoud', value: message.content.slice(0, 1000) || '*(geen tekst)*' },
        ])],
      }).catch(() => {});
    }
  });

  client.on('messageUpdate', async (oldMsg, newMsg) => {
    if (!newMsg.guild || oldMsg.content === newMsg.content) return;
    logEvent({
      type: 'message_edit',
      actorId: newMsg.author?.id ?? null,
      channelId: newMsg.channel.id,
      detail: { before: oldMsg.content?.slice(0, 500), after: newMsg.content?.slice(0, 500) },
    });
  });

  client.on('guildMemberAdd', (member) => {
    logEvent({ type: 'member_join', actorId: member.id, detail: { accountCreated: member.user.createdTimestamp } });
  });

  client.on('guildMemberRemove', (member) => {
    logEvent({ type: 'member_leave', actorId: member.id });
  });

  client.on('guildBanAdd', (ban) => {
    logEvent({ type: 'member_ban', targetId: ban.user.id, detail: { reason: ban.reason }, severity: 'warning' });
  });

  client.on('guildBanRemove', (ban) => {
    logEvent({ type: 'member_unban', targetId: ban.user.id });
  });

  client.on('roleCreate', (role) => {
    logEvent({ type: 'role_create', detail: { name: role.name, permissions: role.permissions.bitfield.toString() } });
  });

  client.on('roleDelete', (role) => {
    logEvent({ type: 'role_delete', detail: { name: role.name }, severity: 'warning' });
  });

  client.on('roleUpdate', (oldRole, newRole) => {
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      logEvent({
        type: 'role_permissions_changed',
        detail: { name: newRole.name, before: oldRole.permissions.bitfield.toString(), after: newRole.permissions.bitfield.toString() },
        severity: 'warning',
      });
    }
  });

  client.on('webhooksUpdate', (channel) => {
    logEvent({ type: 'webhooks_update', channelId: channel.id, severity: 'info' });
  });
}

module.exports = { registerLogging, buildEmbed };
