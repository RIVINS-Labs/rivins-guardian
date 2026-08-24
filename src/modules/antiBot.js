// src/modules/antiBot.js
//
// Grijpt zelf in: elke bot die de server binnenkomt en niet op de whitelist
// staat, wordt automatisch gekickt. Dit voorkomt het scenario waarbij iemand
// een kwaadaardige bot toevoegt (of een bestaand account met "Manage Server"
// dat bewust/onbewust misbruikt wordt) voordat een mens het opmerkt.
//
// Whitelist via ANTI_BOT_WHITELIST (comma-gescheiden user-ID's van bots die
// WEL welkom zijn, bv. je eigen RIVINS Helper/CBH/GSW en MEE6/Free Stuff).
// RIVINS Guardian zelf hoeft niet op de whitelist — die controleert zichzelf
// niet (Discord stuurt geen guildMemberAdd-event voor de bot over zichzelf
// op het moment van joinen via deze listener toch, en zelfs als dat wel
// zo was: een bot kickt zichzelf niet, zie de check hieronder).

const { logEvent } = require('../db');
const { buildEmbed } = require('./logging');

function getWhitelist() {
  return (process.env.ANTI_BOT_WHITELIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function handleGuildMemberAdd(member, { alertChannelId }) {
  if (!member.user.bot) return; // alleen bots, gewone leden vallen onder antiRaid

  const client = member.client;
  if (member.id === client.user.id) return; // nooit tegen zichzelf

  const whitelist = getWhitelist();
  if (whitelist.includes(member.id)) {
    logEvent({ type: 'antibot_whitelisted_join', actorId: member.id, severity: 'info' });
    return;
  }

  logEvent({
    type: 'antibot_unauthorized_kick',
    actorId: member.id,
    detail: { botName: member.user.username },
    severity: 'critical',
  });

  const alertChannel = client.channels.cache.get(alertChannelId);

  try {
    await member.kick('RIVINS Guardian — niet-geautoriseerde bot, niet op ANTI_BOT_WHITELIST');
    if (alertChannel) {
      await alertChannel.send({
        embeds: [buildEmbed('🤖 Niet-geautoriseerde bot gekickt', [
          { name: 'Bot', value: `${member.user.username} (${member.id})`, inline: true },
          { name: 'Actie', value: 'Automatisch gekickt (geen whitelist-match)', inline: true },
          { name: 'Whitelist uitbreiden?', value: "Voeg het ID toe aan ANTI_BOT_WHITELIST als dit een gewenste bot is, en nodig hem opnieuw uit." },
        ], 'critical')],
      }).catch(() => {});
    }
  } catch (err) {
    // Kan gebeuren als de bot een hogere rol heeft dan Guardian, of als
    // Guardian de Kick Members-permissie mist.
    logEvent({
      type: 'antibot_kick_failed',
      actorId: member.id,
      detail: { error: err.message },
      severity: 'critical',
    });
    if (alertChannel) {
      await alertChannel.send({
        embeds: [buildEmbed('⚠️ Kon niet-geautoriseerde bot NIET kicken', [
          { name: 'Bot', value: `${member.user.username} (${member.id})`, inline: true },
          { name: 'Fout', value: err.message },
          { name: 'Actie vereist', value: 'Handmatig controleren en verwijderen — check ook of Guardian\'s eigen rol hoog genoeg staat.' },
        ], 'critical')],
      }).catch(() => {});
    }
  }
}

module.exports = { handleGuildMemberAdd, getWhitelist };
