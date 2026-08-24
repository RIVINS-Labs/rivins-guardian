// src/modules/voiceLogs.js
// Logt joins/leaves/moves tussen voice-kanalen. Puur observerend, geen acties.

const { logEvent } = require('../db');
const { buildEmbed } = require('./logging');

function registerVoiceLogs(client, logChannelId) {
  client.on('voiceStateUpdate', (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member) return;

    const logChannel = client.channels.cache.get(logChannelId);

    // Join
    if (!oldState.channelId && newState.channelId) {
      logEvent({ type: 'voice_join', actorId: member.id, channelId: newState.channelId, severity: 'info' });
      return;
    }
    // Leave
    if (oldState.channelId && !newState.channelId) {
      logEvent({ type: 'voice_leave', actorId: member.id, channelId: oldState.channelId, severity: 'info' });
      return;
    }
    // Move
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      logEvent({
        type: 'voice_move',
        actorId: member.id,
        channelId: newState.channelId,
        detail: { from: oldState.channelId, to: newState.channelId },
        severity: 'info',
      });
    }
    // Server mute/deafen wijzigingen (relevant voor moderatie-overzicht)
    if (oldState.serverMute !== newState.serverMute || oldState.serverDeaf !== newState.serverDeaf) {
      logEvent({
        type: 'voice_server_mute_deafen_changed',
        actorId: member.id,
        channelId: newState.channelId,
        detail: { serverMute: newState.serverMute, serverDeaf: newState.serverDeaf },
        severity: 'info',
      });
    }
  });
}

module.exports = { registerVoiceLogs };
