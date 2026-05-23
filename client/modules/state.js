// ── DOM refs ──
export const dom = {
  roomInput: document.getElementById('room'),
  joinBtn: document.getElementById('join'),
  toggleMicBtn: document.getElementById('toggle-mic'),
  toggleSystemBtn: document.getElementById('toggle-system'),
  statusEl: document.getElementById('status'),
  accessUrlEl: document.getElementById('access-url'),
  playbackMeterFillEl: document.getElementById('playback-meter-fill'),
  playbackMeterTextEl: document.getElementById('playback-meter-text'),
  playbackMeterStateEl: document.getElementById('playback-meter-state'),
  statsRawEl: document.getElementById('stats-raw'),
  statsCopyBtn: document.getElementById('stats-copy-btn'),
  statsCopyStatus: document.getElementById('stats-copy-status'),
  localContainer: document.getElementById('local'),
  remotes: document.getElementById('remotes'),
};

// ── Shared mutable state ──
// Accessed via S.xxx from all modules
export const S = {
  pcMap: {},
  ws: null,
  micStream: null,
  systemStream: null,
  micEnabled: false,
  systemEnabled: false,
  localPreviewAudio: null,
  myId: undefined,
  audioContext: null,
  mixDestination: null,
  mixStream: null,
  mixTrack: null,
  micSourceNode: null,
  systemSourceNode: null,
  micGainNode: null,
  systemGainNode: null,
  micAnalyser: null,
  systemAnalyser: null,
  inputMeterRaf: 0,
  playbackAudioContext: null,
  playbackAnalyser: null,
  playbackMeterRaf: 0,
  playbackStreamSources: new Map(),
  remoteAudioSources: {},
  myRole: 'host',
  peerRoles: {},
  joined: false,
  listenerAudioContext: null,
  listenerGainNode: null,
  listenerMuted: false,
  wsReconnectTimer: null,
  wsReconnectAttempts: 0,
};

// Expose for debugging
window.__pcMap = S.pcMap;

// ICE servers: local STUN takes the LAN IP from /api/access-url so it works
// even when the page is accessed via Cloudflare / reverse proxy.
export const servers = {
  iceServers: [
    { urls: '' }, // placeholder — filled by updateAccessUrl
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};
