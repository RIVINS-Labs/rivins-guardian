// src/modules/warnSystem.js
//
// /warn, /warns, /unwarn — persistent opgeslagen in dezelfde SQLite-database
// als de rest van Guardian. Alleen bruikbaar door leden met de
// Moderate Members-permissie (Discord's eigen permissiesysteem regelt de
// toegangscontrole, niet een losse rollenlijst).

const { SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
const { addWarn, getWarns, deactivateWarn, logEvent } = require('../db');
const { buildEmbed } = require('./logging');

const commands = [
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Geef een lid een waarschuwing')
    .addUserOption(o => o.setName('user').setDescription('Wie waarschuw je').setRequired(true))
    .addStringOption(o => o.setName('reden').setDescription('Reden voor de waarschuwing').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warns')
    .setDescription('Bekijk de waarschuwingen van een lid')
    .addUserOption(o => o.setName('user').setDescription('Van wie').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Trek een waarschuwing in')
    .addIntegerOption(o => o.setName('warning_id').setDescription('ID van de waarschuwing (zie /warns)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
].map(c => c.toJSON());

async function registerCommands(token, clientId, guildId) {
  const rest = new REST({ version: '10' }).setToken(token);
  // Guild-scoped registratie: direct beschikbaar, i.p.v. tot een uur wachten
  // bij globale registratie. Prima voor een bot die op één server draait.
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'warn') {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reden');
    const warnId = addWarn(user.id, interaction.user.id, reason);

    logEvent({ type: 'warn_issued', actorId: interaction.user.id, targetId: user.id, detail: { reason, warnId }, severity: 'info' });

    await interaction.reply({
      embeds: [buildEmbed('⚠️ Waarschuwing gegeven', [
        { name: 'Lid', value: `<@${user.id}>`, inline: true },
        { name: 'Door', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Waarschuwing-ID', value: `#${warnId}`, inline: true },
        { name: 'Reden', value: reason },
      ], 'warning')],
    });

    // Probeer het lid ook een DM te sturen — mislukt stilletjes als DM's dicht staan
    await user.send({
      embeds: [buildEmbed(`Je hebt een waarschuwing gekregen in ${interaction.guild.name}`, [
        { name: 'Reden', value: reason },
      ], 'warning')],
    }).catch(() => {});
    return;
  }

  if (interaction.commandName === 'warns') {
    const user = interaction.options.getUser('user');
    const warns = getWarns(user.id);

    if (warns.length === 0) {
      await interaction.reply({ content: `<@${user.id}> heeft geen actieve waarschuwingen.`, ephemeral: true });
      return;
    }

    const fields = warns.slice(0, 10).map(w => ({
      name: `#${w.id} — ${new Date(w.created_at).toLocaleDateString('nl-NL')}`,
      value: `Door <@${w.moderator_id}>: ${w.reason}`,
    }));

    await interaction.reply({
      embeds: [buildEmbed(`Waarschuwingen voor ${user.username} (${warns.length} totaal)`, fields, 'warning')],
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'unwarn') {
    const warnId = interaction.options.getInteger('warning_id');
    const success = deactivateWarn(warnId);

    logEvent({ type: 'warn_revoked', actorId: interaction.user.id, detail: { warnId, success }, severity: 'info' });

    await interaction.reply({
      content: success ? `Waarschuwing #${warnId} is ingetrokken.` : `Geen waarschuwing gevonden met ID #${warnId}.`,
      ephemeral: true,
    });
  }
}

module.exports = { commands, registerCommands, handleInteraction };
