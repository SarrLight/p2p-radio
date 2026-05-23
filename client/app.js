import { dom, S, servers, audioDebug } from './modules/state.js';
import { launchFireworks, updateStatus, setPlaybackMeter, updateAccessUrl } from './modules/ui.js';
import { fetchRooms, startRoomPolling, updateRoleSelectorForRoom } from './modules/room-ui.js';
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

// ── Join button ────────────────────────────────────────────────────────
dom.joinBtn.onclick = async () => {
  if (S.joined) { console.warn('Already joined, ignoring click'); return; }
  const roomName = dom.roomInput.value.trim();
  if (!roomName) { dom.statusEl.textContent = '请输入电台名称'; return; }
  dom.roomInput.value = roomName;
  dom.joinBtn.disabled = true;
  document.querySelectorAll('#role-selector button, #room').forEach(el => el.disabled = true);
  document.getElementById('role-selector').style.opacity = '0.5';

  try { localStorage.setItem('p2p_room', dom.roomInput.value); } catch (_) {}
  try { localStorage.setItem('p2p_role', S.myRole); } catch (_) {}

  // iOS Safari: AudioContext MUST be created inside the user gesture
  {
    // Always create a fresh AudioContext inside the user gesture.
    // The one from tryAutoRejoin (pageshow) was created outside gesture
    // and Edge iOS may not fully trust it even after .resume().
    try {
      S.listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      S.listenerAudioContext.resume().catch(() => {});
    } catch (_) {}
    // Prime the audio session: keep a silent oscillator running until
    // ontrack actually plays audio.  Edge iOS deactivates the audio
    // output path if nothing is connected to destination between the
    // gesture and the async ontrack callback.
    if (S.listenerAudioContext && S.listenerAudioContext.state === 'running') {
      try {
        const ctx = S.listenerAudioContext;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        // Store reference so ontrack can stop it when real audio starts
        S._primeOsc = osc;
        S._primeGain = gain;
        audioDebug.primeOscActive = true;
        // Safety cleanup after 30s (ontrack should have fired by then)
        setTimeout(() => { if (S._primeOsc) { try { S._primeOsc.stop(); S._primeOsc.disconnect(); S._primeGain.disconnect(); } catch(_) {} S._primeOsc = null; S._primeGain = null; } }, 30000);
      } catch (_) {}
    }
  }

  connectWs();
};

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

// ── Role selector ──────────────────────────────────────────────────────
document.getElementById('role-host').addEventListener('click', () => {
  if (document.getElementById('role-host').disabled) return;
  document.getElementById('role-host').classList.add('active');
  document.getElementById('role-listener').classList.remove('active');
  S.myRole = 'host';
});
document.getElementById('role-listener').addEventListener('click', () => {
  document.getElementById('role-listener').classList.add('active');
  document.getElementById('role-host').classList.remove('active');
  S.myRole = 'listener';
});

// ── Room input ─────────────────────────────────────────────────────────
dom.roomInput.addEventListener('input', () => {
  updateRoleSelectorForRoom(dom.roomInput.value.trim());
});

// ── Reaction bar ───────────────────────────────────────────────────────
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
    // First click after join: user gesture — kickstart <audio>.play()
    if (!S._audioActivated) {
      S._audioActivated = true;
      document.querySelectorAll('#remotes audio').forEach(a => {
        a.play().catch(() => {});
        a.muted = false;
      });
      if (S.listenerGainNode) S.listenerGainNode.gain.value = 1;
      S.listenerMuted = false;
      muteBtn.textContent = '🔊 收听中';
      muteBtn.classList.remove('muted');
      console.log('[mute] audio activated by user gesture');
      return;
    }

    S.listenerMuted = !S.listenerMuted;
    if (S.listenerGainNode) S.listenerGainNode.gain.value = S.listenerMuted ? 0 : 1;
    document.querySelectorAll('#remotes audio').forEach(a => {
      a.muted = S.listenerMuted;
      if (!S.listenerMuted) a.play().catch(() => {});
    });
    muteBtn.textContent = S.listenerMuted ? '🔇 已静音' : '🔊 收听中';
    muteBtn.classList.toggle('muted', S.listenerMuted);
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
  // Sync mute button UI if this click activated audio
  if (S._audioActivated && muteBtn && muteBtn.textContent === '🔇 点击播放') {
    muteBtn.textContent = '🔊 收听中';
    muteBtn.classList.remove('muted');
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
updateAccessUrl();

// If URL has a hash (shared link), pre-fill the room name
const hashRoom = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch(_) { return ''; } })();
if (hashRoom && !S.joined) {
  dom.roomInput.value = hashRoom;
  updateRoleSelectorForRoom(hashRoom);
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

    // Check if room already has a host (roomData populated by fetchRooms)
    // This may change S.myRole to 'listener'
    updateRoleSelectorForRoom(savedRoom);

    if (S.myRole === 'host') {
      document.getElementById('role-host').classList.add('active');
      document.getElementById('role-listener').classList.remove('active');
    } else {
      document.getElementById('role-listener').classList.add('active');
      document.getElementById('role-host').classList.remove('active');
    }

    dom.statusEl.textContent = '页面已刷新，表单已恢复。点击"加入"继续。';
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
