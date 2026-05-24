import { dom, S, servers, audioDebug } from './modules/state.js';
import { launchFireworks, updateStatus, setPlaybackMeter, initStunServer } from './modules/ui.js';
import { fetchRooms, startRoomPolling } from './modules/room-ui.js';
import { enableMic, disableMic, enableSystemAudio, disableSystemAudio } from './modules/audio.js';
import { connectWs } from './modules/ws.js';
import { leaveRoom } from './modules/room.js';

// ── Copy stats button ──────────────────────────────────────────────────
if (dom.statsCopyBtn) {
  dom.statsCopyBtn.addEventListener('click', async () => {
    const text = dom.statsRawEl ? dom.statsRawEl.textContent || '' : '';
    if (!text) {
      if (dom.statsCopyStatus) dom.statsCopyStatus.textContent = '暂无数据可复制';
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (dom.statsCopyStatus) {
        dom.statsCopyStatus.textContent = '已复制';
        setTimeout(() => { dom.statsCopyStatus.textContent = ''; }, 2000);
      }
    } catch (e) {
      if (dom.statsCopyStatus) dom.statsCopyStatus.textContent = '复制失败';
    }
  });
}

// ── Create / Join buttons ──────────────────────────────────────────────
async function doJoin(role) {
  if (S.joined) { console.warn('Already joined, ignoring click'); return; }
  const roomName = dom.roomInput.value.trim();
  if (!roomName) { dom.statusEl.textContent = '请输入电台名称'; return; }
  dom.roomInput.value = roomName;
  S.myRole = role;

  dom.createBtn.disabled = true;
  dom.joinBtn.disabled = true;
  dom.roomInput.disabled = true;

  try { localStorage.setItem('p2p_room', dom.roomInput.value); } catch (_) {}
  try { localStorage.setItem('p2p_role', S.myRole); } catch (_) {}

  // iOS Safari: AudioContext MUST be created inside the user gesture
  {
    try {
      S.listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      S.listenerAudioContext.resume().catch(() => {});
    } catch (_) {}
    if (S.listenerAudioContext && S.listenerAudioContext.state === 'running') {
      try {
        const ctx = S.listenerAudioContext;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        S._primeOsc = osc;
        S._primeGain = gain;
        audioDebug.primeOscActive = true;
        setTimeout(() => {
          if (S._primeOsc) { try { S._primeOsc.stop(); S._primeOsc.disconnect(); S._primeGain.disconnect(); } catch(_) {} S._primeOsc = null; S._primeGain = null; }
        }, 30000);
      } catch (_) {}
    }
  }

  connectWs();
}

dom.createBtn.onclick = () => doJoin('host');
dom.joinBtn.onclick = () => doJoin('listener');

// ── Leave button ───────────────────────────────────────────────────────
const leaveBtn = document.getElementById('leave');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => { leaveRoom(); });
}

// ── Toggle mic ─────────────────────────────────────────────────────────
dom.toggleMicBtn.onclick = async () => {
  try {
    if (S.micEnabled) {
      disableMic();
    } else {
      await enableMic();
    }
  } catch (error) {
    console.error(error);
    dom.statusEl.textContent = '麦克风开启失败：' + error.message;
  }
};

// ── Toggle system audio ────────────────────────────────────────────────
dom.toggleSystemBtn.onclick = async () => {
  try {
    if (S.systemEnabled) {
      disableSystemAudio();
    } else {
      await enableSystemAudio();
    }
  } catch (error) {
    console.error(error);
    dom.statusEl.textContent = '系统声音开启失败：' + error.message;
  }
};

// ── Copy shareable link ────────────────────────────────────────────────
document.querySelectorAll('#reaction-bar button[data-emoji]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
    S.ws.send(JSON.stringify({ type: 'reaction', emoji: btn.dataset.emoji }));
  });
});

// ── Firework button ────────────────────────────────────────────────────
const fwBtn = document.getElementById('firework-btn');
if (fwBtn) {
  fwBtn.addEventListener('click', () => {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
    S.ws.send(JSON.stringify({ type: 'firework' }));
    launchFireworks();
  });
}

// ── Mute button ────────────────────────────────────────────────────────
const muteBtn = document.getElementById('mute-btn');
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    S.listenerMuted = !S.listenerMuted;
    if (S.listenerGainNode) S.listenerGainNode.gain.value = S.listenerMuted ? 0 : 1;
    document.querySelectorAll('#remotes audio').forEach(a => {
      a.muted = S.listenerMuted;
    });
    muteBtn.textContent = S.listenerMuted ? '🔇 已静音' : '🔊 收听中';
    muteBtn.classList.toggle('muted', S.listenerMuted);
  });
}

// ── Start overlay (tap-to-play) ────────────────────────────────────────
const overlay = document.getElementById('start-overlay');
if (overlay) {
  overlay.addEventListener('click', () => {
    if (!S.joined || S._audioActivated) return;
    // User gesture — start all pending <audio> elements
    document.querySelectorAll('#remotes audio').forEach(a => {
      a.play().catch(() => {});
      a.muted = false;
    });
    if (S.listenerGainNode) S.listenerGainNode.gain.value = 1;
    S._audioActivated = true;
    overlay.classList.remove('show');
    const btn = document.getElementById('mute-btn');
    if (btn) { btn.textContent = '🔊 收听中'; btn.classList.remove('muted'); }
  });
}

// Any click after joining should try to start <audio>.play() since
// ontrack runs outside the initial gesture context (Edge iOS).
document.addEventListener('click', () => {
  if (!S.joined) return;
  document.querySelectorAll('#remotes audio').forEach(a => {
    if (a.paused) {
      a.play().catch(() => {});
      S._audioActivated = true;
    }
  });
  // Sync overlay + mute button if this click activated audio
  if (S._audioActivated) {
    const ov = document.getElementById('start-overlay');
    if (ov) ov.classList.remove('show');
    if (muteBtn && muteBtn.textContent === '🔇 点击播放') {
      muteBtn.textContent = '🔊 收听中';
      muteBtn.classList.remove('muted');
    }
  }
}, { passive: true });

// ── Copy shareable link ────────────────────────────────────────────────
document.getElementById('copy-link').addEventListener('click', async () => {
  const url = location.origin + '/' + '#' + encodeURIComponent(dom.roomInput.value.trim() || 'test');
  try {
    await navigator.clipboard.writeText(url);
    dom.statusEl.textContent = '链接已复制：' + url;
    setTimeout(() => updateStatus(), 3000);
  } catch (_) {
    dom.statusEl.textContent = '复制失败，请手动复制地址栏链接';
  }
});

// ── Initialization ─────────────────────────────────────────────────────
dom.toggleMicBtn.disabled = true;
dom.toggleSystemBtn.disabled = true;
initStunServer();

// If URL has a hash (shared link), pre-fill the room name
const hashRoom = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch(_) { return ''; } })();
if (hashRoom && !S.joined) {
  dom.roomInput.value = hashRoom;
}

updateStatus();
startRoomPolling();

// ── Auto-rejoin on page refresh ────────────────────────────────────────
async function tryAutoRejoin() {
  try {
    if (S.joined) return;

    const hashRoom = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch(_) { return ''; } })();
    if (hashRoom) return;

    let savedRoom, savedRole;
    try { savedRoom = localStorage.getItem('p2p_room'); } catch (_) {}
    try { savedRole = localStorage.getItem('p2p_role'); } catch (_) {}
    if (!savedRoom || !savedRole) return;

    dom.roomInput.value = savedRoom;
    S.myRole = savedRole;

    dom.statusEl.textContent = '检测到上次会话，正在重连…';
    // Auto-rejoin with the saved role
    setTimeout(() => {
      if (!S.joined && !dom.createBtn.disabled) {
        if (S.myRole === 'host') dom.createBtn.click();
        else dom.joinBtn.click();
      }
    }, 500);
  } catch (e) {
    console.error('tryAutoRejoin:', e);
  }
}

if (document.readyState === 'complete') {
  tryAutoRejoin();
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      // bfcache restore — reset stale state
      S.joined = false;
      S.myId = undefined;
      S.ws = null;
      S.wsReconnectAttempts = 0;
      if (S.wsReconnectTimer) { clearTimeout(S.wsReconnectTimer); S.wsReconnectTimer = null; }
      // bfcache preserves JS objects — close stale AudioContext
      if (S.listenerAudioContext) {
        try { S.listenerAudioContext.close(); } catch(_) {}
        S.listenerAudioContext = null;
        S.listenerGainNode = null;
      }
    }
    tryAutoRejoin();
  });
}

// ── Notify server before unload ────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (S.joined && S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'leave' }));
  }
});

// ── Debug helper ───────────────────────────────────────────────────────
window.__debug = () => {
  const state = {
    joined: S.joined,
    myId: S.myId,
    myRole: S.myRole,
    ws: S.ws ? (S.ws.readyState === WebSocket.OPEN ? 'OPEN' :
                S.ws.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                S.ws.readyState === WebSocket.CLOSING ? 'CLOSING' :
                S.ws.readyState === WebSocket.CLOSED ? 'CLOSED' : S.ws.readyState) : null,
    listenerAudioContext: S.listenerAudioContext ? {
      state: S.listenerAudioContext.state,
      sampleRate: S.listenerAudioContext.sampleRate,
      baseLatency: S.listenerAudioContext.baseLatency,
    } : null,
    listenerGainNode: S.listenerGainNode ? { gain: S.listenerGainNode.gain.value } : null,
    audioContext: S.audioContext ? { state: S.audioContext.state } : null,
    playbackAudioContext: S.playbackAudioContext ? { state: S.playbackAudioContext.state } : null,
    peers: Object.keys(S.pcMap).reduce((acc, id) => {
      const pc = S.pcMap[id];
      acc[id] = {
        connState: pc.connectionState,
        iceState: pc.iceConnectionState,
        signState: pc.signalingState,
        localCandidates: [],
        remoteCandidates: [],
        senders: pc._senders ? Object.keys(pc._senders).filter(k => pc._senders[k]).length : 0,
      };
      if (pc.localDescription) acc[id].localSDP = pc.localDescription.sdp.slice(0, 200);
      return acc;
    }, {}),
    remoteAudioSources: Object.keys(S.remoteAudioSources),
    peerRoles: S.peerRoles,
  };
  console.table(state.peers, ['connState','iceState','signState','senders']);
  console.log('__debug full state:', JSON.stringify(state, null, 2));
  state.wsReconnectAttempts = S.wsReconnectAttempts;
  state.micEnabled = S.micEnabled;
  state.systemEnabled = S.systemEnabled;
  state.listenerMuted = S.listenerMuted;
  state.p2p_room = (() => { try { return localStorage.getItem('p2p_room'); } catch(_) { return null; } })();
  state.p2p_role = (() => { try { return localStorage.getItem('p2p_role'); } catch(_) { return null; } })();
  state.hash = location.hash;
  console.table(state);
  return state;
};
