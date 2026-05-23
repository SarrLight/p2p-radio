import { dom, S } from './state.js';
import { resetPeerConnections } from './peer.js';
import { disableMic, disableSystemAudio, stopInputMeter } from './audio.js';
import { updateStatus, setPlaybackMeter, ensureListenerGain } from './ui.js';
import { fetchRooms, stopRoomPolling } from './room-ui.js';
import { stopStatsPolling } from './stats.js';

export function leaveRoom() {
  // Clear saved room FIRST
  try { localStorage.removeItem('p2p_room'); } catch (_) {}
  try { localStorage.removeItem('p2p_role'); } catch (_) {}
  try { history.replaceState(null, '', location.pathname); } catch (_) {}

  try {
    if (S.wsReconnectTimer) { clearTimeout(S.wsReconnectTimer); S.wsReconnectTimer = null; }
    S.wsReconnectAttempts = 0;

    if (S.ws) {
      S.ws.onclose = null;
      S.ws.close();
      S.ws = null;
    }

    resetPeerConnections();

    if (S.micEnabled) disableMic();
    if (S.systemEnabled) disableSystemAudio();

    stopInputMeter();

    if (S.audioContext) {
      S.audioContext.close();
      S.audioContext = null;
      S.mixDestination = null; S.mixStream = null; S.mixTrack = null;
      S.micGainNode = null; S.systemGainNode = null;
      S.micAnalyser = null; S.systemAnalyser = null;
      S.micSourceNode = null; S.systemSourceNode = null;
    }
    if (S.listenerAudioContext) {
      const wasPlaybackShared = (S.playbackAudioContext === S.listenerAudioContext);
      S.listenerAudioContext.close();
      S.listenerAudioContext = null;
      S.listenerGainNode = null;
      // playbackAudioContext reuses listenerAudioContext on iOS — already closed above
      if (wasPlaybackShared) S.playbackAudioContext = null;
    }
    if (S.playbackAudioContext) {
      S.playbackAudioContext.close();
    }
    S.playbackAudioContext = null;
    S.playbackAnalyser = null;
    if (S.playbackMeterRaf) { cancelAnimationFrame(S.playbackMeterRaf); S.playbackMeterRaf = 0; }

    if (S.localPreviewAudio) {
      try { S.localPreviewAudio.remove(); } catch (_) {}
      S.localPreviewAudio = null;
    }

    // Stop priming oscillator if still running
    if (S._primeOsc) {
      try { S._primeOsc.stop(); S._primeOsc.disconnect(); S._primeGain.disconnect(); } catch(_) {}
      S._primeOsc = null;
      S._primeGain = null;
    }

    S.joined = false;
    S.myId = undefined;

    stopStatsPolling();

    const container = document.getElementById('stats-container');
    if (container) container.innerHTML = '无连接';
    if (dom.statsRawEl) dom.statsRawEl.textContent = '等待数据...';

    dom.joinBtn.classList.remove('hidden');
    const leaveBtn = document.getElementById('leave');
    if (leaveBtn) leaveBtn.classList.add('hidden');
    dom.joinBtn.disabled = false;
    document.getElementById('room-list').classList.remove('disabled');
    document.querySelectorAll('#role-selector button, #room').forEach(el => el.disabled = false);
    document.getElementById('role-host').classList.remove('locked');
    document.getElementById('role-selector').style.opacity = '1';
    document.getElementById('host-controls').style.display = 'none';
    document.getElementById('host-meters').style.display = 'none';
    document.getElementById('listener-meters').style.display = 'block';
    document.getElementById('reaction-bar').style.display = 'none';

    const muteBtn = document.getElementById('mute-btn');
    if (muteBtn) { muteBtn.classList.add('hidden'); muteBtn.textContent = '🔊 收听中'; muteBtn.classList.remove('muted'); }
    S.listenerMuted = false;
    if (S.listenerGainNode) S.listenerGainNode.gain.value = 1;

    for (const k of Object.keys(S.reactionCounts)) S.reactionCounts[k] = 0;
    document.querySelectorAll('#reaction-bar .rc').forEach(el => el.textContent = '0');
    dom.toggleMicBtn.disabled = true;
    dom.toggleSystemBtn.disabled = true;

    setPlaybackMeter(0, -120, false);
    updateStatus();
    fetchRooms();
  } catch (e) {
    console.error('leaveRoom error:', e);
    location.reload();
  }
}
