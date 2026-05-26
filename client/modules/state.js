// ── DOM refs ──
export const dom = {
  roomInput: document.getElementById('room'),
  createBtn: document.getElementById('btn-create'),
  joinBtn: document.getElementById('btn-join'),
  toggleMicBtn: document.getElementById('toggle-mic'),
  toggleSystemBtn: document.getElementById('toggle-system'),
  statusEl: document.getElementById('status'),
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
  peerNames: {},
  myUserSub: null,
  joined: false,
  listenerAudioContext: null,
  listenerGainNode: null,
  listenerMuted: false,
  reactionCounts: { '😭': 0, '👍': 0, '❤️': 0, '🥰': 0, '🥳': 0 },
  _audioActivated: false,   // set true after first user gesture play()
  wsReconnectTimer: null,
  wsReconnectAttempts: 0,
};

// Expose for debugging
window.__pcMap = S.pcMap;

// Audio diagnostics — updated at key decision points
export const audioDebug = {
  ua: navigator.userAgent,
  platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints,
  isIOS: null,       // set at playback decision time
  isSafari: null,    // set at playback decision time
  path: null,        // 'ios-audio' | 'non-ios-audio' | 'web-audio-fallback'
  audioCtxState: null,
  audioPlayResult: null, // 'fire-and-forget' | 'played' | 'blocked'
  primeOscActive: false,
  ontrackFired: false,
  peerCount: 0,
};
window.__audioDebug = audioDebug;

// ICE servers: local STUN takes the LAN IP from /api/access-url so it works
// even when the page is accessed via Cloudflare / reverse proxy.
export const servers = {
  iceServers: [
    { urls: '' }, // placeholder — filled by updateAccessUrl
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};
