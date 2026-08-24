// src/index.js
// RIVINS Guardian — self-hosted moderation bot.
// Filosofie: alle code hierboven/hieronder is alles wat deze bot doet.
// Geen externe telemetry-calls, geen verborgen accounts, geen fallback-
// commando's buiten wat je hier letterlijk leest. Als je iets niet vertrouwt,
// verwijder je het gewoon uit dit bestand — er zit niets "onder de motorkap".

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { pruneRateTracking } = require('./db');
const antiSpam = require('./modules/antiSpam');
const antiRaid = require('./modules/antiRaid');
const { registerLogging, buildEmbed } = require('./modules/logging');
const { startAdminAbuseWatcher } = require('./modules/adminAbuseDetection');

const {
  DISCORD_TOKEN,
  GUILD_ID,
  OWNER_ID,
  LOG_CHANNEL_ID,
  ADMIN_ALERT_CHANNEL_ID,
  STRICT_MODE, // 'true' om automatische quarantaine bij admin-abuse aan te zetten
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !LOG_CHANNEL_ID || !ADMIN_ALERT_CHANNEL_ID) {
  console.error('Ontbrekende verplichte environment variables. Check .env.example.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration, // bans
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Rollen die van anti-spam-checks worden uitgezonderd (bv. staff-rollen).
// Vul aan met je eigen rol-ID's, bijvoorbeeld @Moderators, @Managers.
const EXEMPT_ROLE_IDS = (process.env.EXEMPT_ROLE_IDS || '').split(',').filter(Boolean);

client.once('ready', () => {
  console.log(`RIVINS Guardian actief als ${client.user.tag}`);
  registerLogging(client, LOG_CHANNEL_ID);
  startAdminAbuseWatcher(client, GUILD_ID, {
    ownerId: OWNER_ID,
    alertChannelId: ADMIN_ALERT_CHANNEL_ID,
    strictMode: STRICT_MODE === 'true',
  });

  // Elk uur oude rate-tracking-data opruimen zodat de database niet blijft groeien
  setInterval(() => pruneRateTracking(), 60 * 60 * 1000);
});

client.on('messageCreate', async (message) => {
  if (message.guildId !== GUILD_ID) return;

  await antiSpam.handleMessage(message, {
    exemptRoleIds: EXEMPT_ROLE_IDS,
    onViolation: async (msg, violations) => {
      const alertChannel = client.channels.cache.get(ADMIN_ALERT_CHANNEL_ID);
      if (alertChannel) {
        await alertChannel.send({
          embeds: [buildEmbed('🛑 Anti-spam trigger', [
            { name: 'Kanaal', value: `<#${msg.channel.id}>`, inline: true },
            { name: 'Auteur', value: msg.webhookId ? `Webhook (${msg.author.username})` : `<@${msg.author.id}>`, inline: true },
            { name: 'Overtredingen', value: violations.join('\n') },
          ], 'warning')],
        }).catch(() => {});
      }
      // Bewust GEEN automatische delete/ban hier — alleen alarmeren.
      // Wil je dat berichten automatisch verwijderd worden, voeg dat hier
      // bewust en zichtbaar toe, bijvoorbeeld:
      // if (!msg.webhookId) await msg.delete().catch(() => {});
    },
  });

  await antiRaid.checkWebhookActivity(message, {
    onSuspiciousWebhook: async (msg, count) => {
      const alertChannel = client.channels.cache.get(ADMIN_ALERT_CHANNEL_ID);
      if (alertChannel) {
        await alertChannel.send({
          embeds: [buildEmbed('🚨 Verdachte webhook-activiteit', [
            { name: 'Webhook-naam', value: msg.author.username, inline: true },
            { name: 'Kanaal', value: `<#${msg.channel.id}>`, inline: true },
            { name: 'Aantal berichten', value: `${count}x in korte tijd` },
            { name: 'Voorbeeld', value: msg.content?.slice(0, 300) || '*(geen tekst)*' },
          ], 'critical')],
        }).catch(() => {});
      }
    },
  });
});

client.on('guildMemberAdd', async (member) => {
  await antiRaid.handleGuildMemberAdd(member, {
    onRaidDetected: async (guild, count) => {
      const alertChannel = client.channels.cache.get(ADMIN_ALERT_CHANNEL_ID);
      if (alertChannel) {
        await alertChannel.send({
          content: `@here`,
          embeds: [buildEmbed('🚨 Mogelijke join-raid', [
            { name: 'Aantal joins', value: `${count} in korte tijd` },
            { name: 'Advies', value: 'Overweeg tijdelijk verification-level te verhogen (Server Settings → Safety Setup).' },
          ], 'critical')],
        }).catch(() => {});
      }
    },
  });
});

client.login(DISCORD_TOKEN);
