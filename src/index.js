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
const antiBot = require('./modules/antiBot');
const timeoutProtection = require('./modules/timeoutProtection');
const { registerLogging, buildEmbed } = require('./modules/logging');
const { registerVoiceLogs } = require('./modules/voiceLogs');
const { startAdminAbuseWatcher } = require('./modules/adminAbuseDetection');
const warnSystem = require('./modules/warnSystem');

const {
  DISCORD_TOKEN,
  GUILD_ID,
  OWNER_ID,
  LOG_CHANNEL_ID,
  ADMIN_ALERT_CHANNEL_ID,
  STRICT_MODE, // 'true' om automatische quarantaine bij ADMIN-abuse aan te zetten (adminAbuseDetection.js)
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
    GatewayIntentBits.GuildVoiceStates, // nodig voor voice-logs
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Rollen die van anti-spam-checks worden uitgezonderd (bv. staff-rollen).
const EXEMPT_ROLE_IDS = (process.env.EXEMPT_ROLE_IDS || '').split(',').filter(Boolean);

client.once('ready', async () => {
  console.log(`RIVINS Guardian actief als ${client.user.tag}`);

  registerLogging(client, LOG_CHANNEL_ID);
  registerVoiceLogs(client, LOG_CHANNEL_ID);

  startAdminAbuseWatcher(client, GUILD_ID, {
    ownerId: OWNER_ID,
    alertChannelId: ADMIN_ALERT_CHANNEL_ID,
    strictMode: STRICT_MODE === 'true',
  });

  try {
    await warnSystem.registerCommands(DISCORD_TOKEN, client.user.id, GUILD_ID);
    console.log('Slash-commands (/warn, /warns, /unwarn) geregistreerd.');
  } catch (err) {
    console.error('Kon slash-commands niet registreren:', err.message);
  }

  // Elk uur oude rate-tracking-data opruimen zodat de database niet blijft groeien
  setInterval(() => pruneRateTracking(), 60 * 60 * 1000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    await warnSystem.handleInteraction(interaction);
  } catch (err) {
    console.error('Fout bij interactie-afhandeling:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: 'Er ging iets mis bij het uitvoeren van dit commando.', ephemeral: true }).catch(() => {});
    }
  }
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
  // Anti-raid: join-snelheid + nieuwe-account-detectie
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

  // Anti-bot: niet-gewhitelistte bots automatisch kicken
  await antiBot.handleGuildMemberAdd(member, { alertChannelId: ADMIN_ALERT_CHANNEL_ID });
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  await timeoutProtection.handleGuildMemberUpdate(oldMember, newMember, {
    ownerId: OWNER_ID,
    alertChannelId: ADMIN_ALERT_CHANNEL_ID,
  });
});

client.login(DISCORD_TOKEN);
