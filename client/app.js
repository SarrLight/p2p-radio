(async function(){
const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('join');
const toggleMicBtn = document.getElementById('toggle-mic');
const toggleSystemBtn = document.getElementById('toggle-system');
const statusEl = document.getElementById('status');
const accessUrlEl = document.getElementById('access-url');
const playbackMeterFillEl = document.getElementById('playback-meter-fill');
const playbackMeterTextEl = document.getElementById('playback-meter-text');
const playbackMeterStateEl = document.getElementById('playback-meter-state');
const statsRawEl = document.getElementById('stats-raw');
const statsCopyBtn = document.getElementById('stats-copy-btn');
const statsCopyStatus = document.getElementById('stats-copy-status');

if (statsCopyBtn) {
  statsCopyBtn.addEventListener('click', async () => {
    const text = statsRawEl ? statsRawEl.textContent || '' : '';
    if (!text) {
      if (statsCopyStatus) statsCopyStatus.textContent = '暂无数据可复制';
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
      if (statsCopyStatus) {
        statsCopyStatus.textContent = '已复制';
        setTimeout(() => { statsCopyStatus.textContent = ''; }, 2000);
      }
    } catch (e) {
      if (statsCopyStatus) statsCopyStatus.textContent = '复制失败';
    }
  });
}
const localContainer = document.getElementById('local');
const remotes = document.getElementById('remotes');

let pcMap = {};
// Expose for debugging and stats collection
window.__pcMap = pcMap;
let ws;
let micStream = null;
let systemStream = null;
let micEnabled = false;
let systemEnabled = false;
let localPreviewAudio = null;
let myId;
let audioContext = null;
let mixDestination = null;
let mixStream = null;
let mixTrack = null;
let micSourceNode = null;
let systemSourceNode = null;
let micGainNode = null;
let systemGainNode = null;
let micAnalyser = null;       // AnalyserNode for host input monitoring
let systemAnalyser = null;    // AnalyserNode for host input monitoring
let inputMeterRaf = 0;        // RAF id for input level loop
let playbackAudioContext = null;
let playbackAnalyser = null;
let playbackMeterRaf = 0;
let playbackStreamSources = new Map();
let remoteAudioSources = {}; // peerId -> MediaStreamAudioSourceNode (for Safari-compatible playback)
let myRole = 'host';                // 'host' or 'listener'
let peerRoles = {};                 // peerId -> role
let joined = false;                 // true after successful join
let listenerAudioContext = null;    // minimal AudioContext for listeners on iOS Safari
let listenerGainNode = null;       // GainNode for mute control on listener playback
let listenerMuted = false;         // whether playback is muted
const reactionCounts = { '😭': 0, '👍': 0, '❤️': 0, '🥰': 0, '🥳': 0 };
let wsReconnectTimer = null;        // setTimeout id for WS reconnection
let wsReconnectAttempts = 0;        // exponential-backoff counter

// ICE servers: local STUN takes the LAN IP from /api/access-url so it works
// even when the page is accessed via Cloudflare / reverse proxy.  Google STUN
// as fallback for when the local one is unreachable.
const servers = {
  iceServers: [
    { urls: '' }, // placeholder — filled by updateAccessUrl
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

// Inject Opus music-optimized parameters into SDP.
// Without this, Opus defaults to VOIP mode (high-pass filter ~80Hz, mono, low target bitrate).
function mungeOpusSdp(sdp) {
  const opusPTs = new Set();
  const re = /a=rtpmap:(\d+) opus\//gi;
  let m;
  while ((m = re.exec(sdp)) !== null) {
    opusPTs.add(m[1]);
  }
  if (opusPTs.size === 0) return sdp;

  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (match, pt, params) => {
    if (!opusPTs.has(pt)) return match;

    const paramMap = {};
    for (const p of params.split(';')) {
      const pTrim = p.trim();
      if (!pTrim) continue;
      const eqIdx = pTrim.indexOf('=');
      if (eqIdx >= 0) {
        paramMap[pTrim.substring(0, eqIdx).trim()] = pTrim.substring(eqIdx + 1).trim();
      } else {
        paramMap[pTrim] = '';
      }
    }

    // Music-optimized Opus: stereo, higher target bitrate, no DTX.
    // VBR (default) gives better quality than CBR for music — complex passages get more bits.
    paramMap['stereo'] = '1';
    paramMap['sprop-stereo'] = '1';
    paramMap['maxaveragebitrate'] = '256000';
    paramMap['usedtx'] = '0';
    // FEC embeds a low-bitrate copy of the previous frame in each packet.
    // Single-packet loss is recovered from the next packet — much smoother audio.
    paramMap['useinbandfec'] = '1';
    paramMap['minptime'] = '10';

    const newParams = Object.entries(paramMap)
      .map(([k, v]) => v !== '' ? `${k}=${v}` : k)
      .join(';');

    return `a=fmtp:${pt} ${newParams}`;
  });
}

function updateAccessUrl() {
  if (!accessUrlEl) {
    return;
  }

  accessUrlEl.textContent = `当前访问地址：读取中...`;

  fetch('/api/access-url')
    .then((response) => response.json())
    .then((data) => {
      if (data && data.url) {
        const interfaceText = data.preferredInterface ? `（网卡：${data.preferredInterface}）` : '';
        accessUrlEl.textContent = `手机访问地址（推荐）：${data.url}${interfaceText}`;
      } else {
        accessUrlEl.textContent = `当前访问地址：${location.origin}`;
      }
      // Update local STUN to use server's actual LAN IP instead of location.hostname.
      // This fixes STUN when the page is accessed via Cloudflare Tunnel / reverse proxy.
      if (data && data.preferredAddress) {
        servers.iceServers[0].urls = `stun:${data.preferredAddress}:3478`;
      }
    })
    .catch(() => {
      accessUrlEl.textContent = `当前访问地址：${location.origin}`;
    });
}

// ── Room discovery ──────────────────────────────────────────────────
let roomPollInterval = null;
let roomData = {}; // roomName -> { hasHost: bool }

async function fetchRooms() {
  const listEl = document.getElementById('room-list');
  if (!listEl) return;
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    const rooms = data.rooms || {};

    // Update host-presence cache
    roomData = {};
    for (const [name, info] of Object.entries(rooms)) {
      roomData[name] = { hasHost: (info.clients || []).some(c => c.role === 'host') };
    }

    // Clear old items
    listEl.querySelectorAll('.rl-item').forEach(el => el.remove());
    const emptyEl = document.getElementById('rl-empty');

    const names = Object.keys(rooms);
    if (names.length === 0) {
      if (emptyEl) emptyEl.textContent = '暂无活跃电台，开一个吧。';
      return;
    }
    if (emptyEl) emptyEl.remove();

    for (const [name, info] of Object.entries(rooms)) {
      const clients = info.clients || [];
      const hosts = clients.filter(c => c.role === 'host').length;
      const listeners = clients.filter(c => c.role === 'listener').length;

      const item = document.createElement('div');
      item.className = 'rl-item';
      item.innerHTML = `<span class="rl-name">${escapeHtml(name)}</span>
        <span class="rl-meta">🎤${hosts} 主播 · 🎧${listeners} 听众</span>`;
      item.addEventListener('click', () => {
        if (joined) return;
        roomInput.value = name;
        updateRoleSelectorForRoom(name);
      });
      listEl.appendChild(item);
    }
  } catch (_) {
    // server not reachable – silently ignore
  }

  // Re-apply role lock for the current room input value
  // (handles the default "test" case on page load).
  if (!joined) updateRoleSelectorForRoom(roomInput.value.trim());
}

function updateRoleSelectorForRoom(roomName) {
  const info = roomData[roomName];
  const hostBtn = document.getElementById('role-host');
  const listenerBtn = document.getElementById('role-listener');
  if (!hostBtn || !listenerBtn) return;

  if (info && info.hasHost && myRole !== 'host') {
    // Room already has a host and we are not it — force listener
    hostBtn.disabled = true;
    hostBtn.classList.add('locked');
    listenerBtn.classList.add('active');
    hostBtn.classList.remove('active');
    myRole = 'listener';
  } else if (!info || !info.hasHost) {
    hostBtn.disabled = false;
    hostBtn.classList.remove('locked');
  }
}

function startRoomPolling(intervalMs = 5000) {
  if (roomPollInterval) return;
  fetchRooms();
  roomPollInterval = setInterval(fetchRooms, intervalMs);
}

function stopRoomPolling() {
  if (roomPollInterval) {
    clearInterval(roomPollInterval);
    roomPollInterval = null;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function ensureListenerGain() {
  if (!listenerGainNode && listenerAudioContext) {
    listenerGainNode = listenerAudioContext.createGain();
    listenerGainNode.gain.value = listenerMuted ? 0 : 1;
    listenerGainNode.connect(listenerAudioContext.destination);
  }
}

function launchFireworks() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const particles = [];   // main burst
  const sparkles = [];   // crackling white sparks (rendered separately on top)
  const rockets = [];
  const glows = [];       // brief flash at burst center
  const colors = ['#f87171','#fb923c','#fbbf24','#4ade80','#60a5fa','#c084fc','#f472b6','#f9a8d4'];
  const goldPalette = ['#fff7cc','#ffe066','#ffd43b','#fab005'];

  const rocketCount = 5 + Math.floor(Math.random() * 4);
  const now0 = performance.now();

  for (let i = 0; i < rocketCount; i++) {
    const launchDelay = Math.random() * 0.6; // staggered launch
    rockets.push({
      x: canvas.width * (0.08 + Math.random() * 0.84),
      y: canvas.height,
      targetY: canvas.height * (0.12 + Math.random() * 0.4),
      speed: 380 + Math.random() * 520,
      trail: [],
      exploded: false,
      launchDelay,
      color: colors[Math.floor(Math.random() * colors.length)],
      wobblePhase: Math.random() * Math.PI * 2,
    });
  }

  let lastTime = now0;
  let elapsed = 0;
  let raf;
  const tick = (now) => {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    elapsed += dt;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const r of rockets) {
      if (elapsed < r.launchDelay) continue;

      if (!r.exploded) {
        // Wobble the trajectory slightly
        r.wobblePhase += dt * 8;
        const wobbleX = Math.sin(r.wobblePhase) * 1.5;
        r.y -= r.speed * dt;
        r.x += wobbleX * dt * 60;

        // Intermittent trail — only add a dot every ~30ms
        r.trail.push({ x: r.x, y: r.y, life: 1, bright: Math.random() > 0.3 });
        if (r.trail.length > 20) r.trail.shift();

        for (let i = 0; i < r.trail.length; i++) {
          const t = r.trail[i];
          t.life -= 2.5 * dt;
          if (t.life <= 0) continue;
          // Staggered brightness: some dots bright, some dim
          const alpha = t.life * (t.bright ? 0.7 : 0.25);
          const size = t.bright ? 2.2 : 1.2;
          ctx.globalAlpha = Math.max(0, alpha);
          ctx.fillStyle = t.bright ? goldPalette[i % 4] : '#fab005';
          ctx.beginPath();
          ctx.arc(t.x, t.y, size, 0, Math.PI * 2);
          ctx.fill();
        }

        // Rocket head with slight glow
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#ffe066';
        ctx.beginPath();
        ctx.arc(r.x, r.y, 6, 0, Math.PI * 2);
        ctx.fill();

        if (r.y <= r.targetY) {
          r.exploded = true;
          // Flash glow at burst center
          glows.push({ x: r.x, y: r.y, life: 0.4, color: r.color });

          // Main burst particles
          for (let j = 0; j < 60; j++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 60 + Math.random() * 580;
            particles.push({
              x: r.x, y: r.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 1, decay: 0.3 + Math.random() * 1.6,
              color: r.color,
              size: 0.8 + Math.random() * 2.2,
            });
          }
          // Sparklets — chaotic crackle, rendered on top
          for (let j = 0; j < 50; j++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 80 + Math.random() * 350;
            sparkles.push({
              x: r.x, y: r.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 0.2 + Math.random() * 0.8,
              decay: 0.8 + Math.random() * 2.5,
              size: 0.8 + Math.random() * 1.5,
            });
          }
        }
      }
    }

    // Update glow flashes
    for (const g of glows) {
      g.life -= dt;
      if (g.life <= 0) continue;
      const alpha = g.life / 0.4;
      const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, 40 * alpha);
      grad.addColorStop(0, g.color);
      grad.addColorStop(0.4, g.color + '88');
      grad.addColorStop(1, 'transparent');
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x, g.y, 40 * alpha, 0, Math.PI * 2);
      ctx.fill();
    }

    // Update main burst particles
    let alive = rockets.some(r => !r.exploded || elapsed < r.launchDelay);
    alive = alive || glows.some(g => g.life > 0);
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += 320 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Render sparkles on top — bright white with glow, chaotic crackle
    for (const s of sparkles) {
      if (s.life <= 0) continue;
      alive = true;
      s.vy += 300 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= s.decay * dt;
      if (s.life <= 0) continue;

      // Random crackle: each frame randomly bright or dim
      const rnd = Math.random();
      if (rnd > 0.55) {
        // Bright flash with glow
        ctx.globalAlpha = s.life * 0.9;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size + 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = s.life * 0.25;
        ctx.fillStyle = '#ffe066';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size + 3.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (rnd > 0.25) {
        ctx.globalAlpha = s.life * 0.4;
        ctx.fillStyle = '#ffe066';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      // else: completely dark this frame (crackle gap)
    }

    if (alive) {
      raf = requestAnimationFrame(tick);
    } else {
      canvas.remove();
    }
  };
  raf = requestAnimationFrame(tick);
}

function showReaction(emoji) {
  if (document.hidden) return; // skip animation if tab is in background
  const el = document.createElement('span');
  el.className = 'reaction-float';
  el.textContent = emoji;
  el.style.left = `${40 + Math.random() * 30}%`;
  el.style.bottom = '30%';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function ensureLocalPreview() {
  if (!localPreviewAudio) {
    localPreviewAudio = document.createElement('audio');
    localPreviewAudio.autoplay = true;
    localPreviewAudio.muted = true;
    localContainer.appendChild(localPreviewAudio);
  }
}

async function ensureAudioPipeline() {
  if (!audioContext) {
    // prefer 48kHz sampling for higher quality
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    } catch (e) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    mixDestination = audioContext.createMediaStreamDestination();
    mixStream = mixDestination.stream;
    mixTrack = mixStream.getAudioTracks()[0] || null;
    micGainNode = audioContext.createGain();
    systemGainNode = audioContext.createGain();
    micAnalyser = audioContext.createAnalyser();
    systemAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    systemAnalyser.fftSize = 256;
    micAnalyser.smoothingTimeConstant = 0.7;
    systemAnalyser.smoothingTimeConstant = 0.7;
    micGainNode.gain.value = 0;
    systemGainNode.gain.value = 0;
    micAnalyser.connect(micGainNode);
    systemAnalyser.connect(systemGainNode);
    micGainNode.connect(mixDestination);
    systemGainNode.connect(mixDestination);
    await audioContext.resume();
  }

  ensureLocalPreview();
  localPreviewAudio.srcObject = mixStream;
}

function setPlaybackMeter(levelPercent, dbfs, isActive) {
  if (playbackMeterFillEl) {
    playbackMeterFillEl.style.width = `${levelPercent}%`;
  }

  if (playbackMeterTextEl) {
    if (dbfs <= -120) {
      playbackMeterTextEl.innerHTML = '&minus;&infin; <small>dBFS</small>';
    } else {
      playbackMeterTextEl.innerHTML = `${dbfs.toFixed(1)} <small>dBFS</small>`;
    }
  }

  if (playbackMeterStateEl) {
    playbackMeterStateEl.textContent = isActive ? '正在播放' : '等待音频流…';
    playbackMeterStateEl.className = 'meter-state' + (isActive ? ' live' : '');
  }
}

function startInputMeter() {
  if (inputMeterRaf) return;
  const micFill = document.getElementById('mic-meter-fill');
  const micVal = document.getElementById('mic-meter-val');
  const sysFill = document.getElementById('sys-meter-fill');
  const sysVal = document.getElementById('sys-meter-val');

  const tick = () => {
    if (!micAnalyser && !systemAnalyser) { inputMeterRaf = 0; return; }

    const updateOne = (analyser, fillEl, valEl) => {
      if (!analyser || !fillEl || !valEl) return;
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const n = (v - 128) / 128; sum += n * n; }
      const rms = Math.sqrt(sum / buf.length);
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
      const pct = Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100));
      fillEl.style.width = `${pct}%`;
      valEl.textContent = `${dbfs.toFixed(1)} dBFS`;
    };

    updateOne(micAnalyser, micFill, micVal);
    updateOne(systemAnalyser, sysFill, sysVal);
    inputMeterRaf = requestAnimationFrame(tick);
  };
  inputMeterRaf = requestAnimationFrame(tick);
}

function stopInputMeter() {
  if (inputMeterRaf) { cancelAnimationFrame(inputMeterRaf); inputMeterRaf = 0; }
  const ids = ['mic-meter-fill','sys-meter-fill','mic-meter-val','sys-meter-val'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id.endsWith('-fill')) el.style.width = '0%';
      else el.textContent = '-∞ dBFS';
    }
  });
}

async function ensurePlaybackMeter() {
  if (!playbackAudioContext) {
    playbackAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    playbackAnalyser = playbackAudioContext.createAnalyser();
    playbackAnalyser.fftSize = 2048;
    playbackAnalyser.smoothingTimeConstant = 0.85;
    playbackAudioContext.resume().catch(() => {});
  }

  if (!playbackMeterRaf) {
    const tick = () => {
      if (!playbackAnalyser) {
        playbackMeterRaf = 0;
        return;
      }

      const buffer = new Uint8Array(playbackAnalyser.fftSize);
      playbackAnalyser.getByteTimeDomainData(buffer);

      let sumSquares = 0;
      for (const value of buffer) {
        const normalized = (value - 128) / 128;
        sumSquares += normalized * normalized;
      }

      const rms = Math.sqrt(sumSquares / buffer.length);
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
      const levelPercent = Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100));
      setPlaybackMeter(levelPercent, dbfs, levelPercent > 3);
      playbackMeterRaf = window.requestAnimationFrame(tick);
    };

    playbackMeterRaf = window.requestAnimationFrame(tick);
  }
}

async function registerPlaybackStream(peerId, stream) {
  await ensurePlaybackMeter();

  const existingSource = playbackStreamSources.get(peerId);
  if (existingSource) {
    try { existingSource.disconnect(); } catch (e) {}
    playbackStreamSources.delete(peerId);
  }

  if (!stream) {
    return;
  }

  const sourceNode = playbackAudioContext.createMediaStreamSource(stream);
  sourceNode.connect(playbackAnalyser);
  playbackStreamSources.set(peerId, sourceNode);
}

function unregisterPlaybackStream(peerId) {
  const sourceNode = playbackStreamSources.get(peerId);
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (e) {}
    playbackStreamSources.delete(peerId);
  }

  if (playbackStreamSources.size === 0) {
    setPlaybackMeter(0, -120, false);
  }
}

function detachSourceNodes(kind) {
  if (kind === 'mic') {
    if (micSourceNode) {
      try { micSourceNode.disconnect(); } catch (e) {}
      micSourceNode = null;
    }
  } else if (kind === 'system') {
    if (systemSourceNode) {
      try { systemSourceNode.disconnect(); } catch (e) {}
      systemSourceNode = null;
    }
  }
}

function connectMediaStreamToGain(stream, gainNode, kind) {
  detachSourceNodes(kind);
  const sourceNode = audioContext.createMediaStreamSource(stream);
  // Connect through the analyser so the host can see input levels
  const analyser = (kind === 'mic') ? micAnalyser : systemAnalyser;
  sourceNode.connect(analyser);
  if (kind === 'mic') {
    micSourceNode = sourceNode;
  } else {
    systemSourceNode = sourceNode;
  }
}

function updateStatus() {
  if (!joined) {
    statusEl.textContent = '请选择角色后加入电台。';
    return;
  }
  if (myRole === 'host') {
    toggleMicBtn.textContent = micEnabled ? '麦克风：开' : '麦克风：关';
    toggleSystemBtn.textContent = systemEnabled ? '系统声音：开' : '系统声音：关';
    statusEl.textContent = `麦克风：${micEnabled ? '开' : '关'}，系统声音：${systemEnabled ? '开（画面已丢弃）' : '关'}。`;
  } else {
    statusEl.textContent = '听众模式，正在收听广播。';
  }
}

function getAudioTrack(stream) {
  if (!stream) {
    return null;
  }

  return stream.getAudioTracks()[0] || null;
}

function refreshLocalPreview() {
  ensureLocalPreview();
  const tracks = [];

  if (micStream) {
    tracks.push(...micStream.getAudioTracks());
  }

  if (systemStream) {
    tracks.push(...systemStream.getAudioTracks());
  }

  localPreviewAudio.srcObject = new MediaStream(tracks);
}

function attachCurrentSources(pc) {
  pc._senders = {};
  // attach mic track directly with low bitrate (16 kbps)
  if (micStream) {
    const micTrack = micStream.getAudioTracks()[0];
    if (micTrack) {
      const sender = pc.addTrack(micTrack, micStream);
      pc._senders.mic = sender;
      console.log(`[attachCurrentSources] Added mic sender to peer`);
      try {
        if (sender && sender.getParameters) {
          const params = sender.getParameters();
          params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
          params.encodings[0].maxBitrate = 16000; // 16 kbps for mic
          sender.setParameters(params).catch(() => {});
        }
      } catch (e) {}
    }
  } else {
    console.log(`[attachCurrentSources] micStream not ready yet`);
  }
}

function addSystemAudioSender(pc) {
  if (!pc || !systemStream) {
    console.log(`[addSystemAudioSender] Skipped: pc=${!!pc}, systemStream=${!!systemStream}`);
    return;
  }
  try {
    if (pc._senders && pc._senders.system) {
      console.log(`[addSystemAudioSender] Already exists, skipping`);
      return; // already added
    }
    const systemTrack = systemStream.getAudioTracks()[0];
    console.log(`[addSystemAudioSender] systemTrack=${!!systemTrack}`);
    if (systemTrack) {
      pc._senders = pc._senders || {};
      const sender = pc.addTrack(systemTrack, systemStream);
      pc._senders.system = sender;
      console.log(`[addSystemAudioSender] Added system sender to peer, will trigger negotiationneeded`);
      // set high bitrate for system audio (320 kbps)
      if (sender && sender.getParameters) {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = 320000; // 320 kbps for system
        sender.setParameters(params).catch(() => {});
      }
      // addTrack automatically triggers negotiationneeded if in 'stable' state
    }
  } catch (e) {
    console.warn('addSystemAudioSender failed', e);
  }
}

function removeSystemAudioSender(pc) {
  if (!pc || !pc._senders || !pc._senders.system) {
    console.log(`[removeSystemAudioSender] Skipped: pc=${!!pc}, has system=${!!(pc && pc._senders && pc._senders.system)}`);
    return;
  }
  try {
    console.log(`[removeSystemAudioSender] Removing system sender`);
    pc.removeTrack(pc._senders.system);
    pc._senders.system = null;
    console.log(`[removeSystemAudioSender] Removed system sender, will trigger negotiationneeded`);
    // removeTrack automatically triggers negotiationneeded if in 'stable' state
  } catch (e) {
    console.warn('removeSystemAudioSender failed', e);
  }
}

// Periodic stats collection and DOM update
let statsIntervalId = null;
// store last bytes/timestamp per peer to compute bitrate delta for in/out
const _lastStats = {};
function startStatsPolling(intervalMs = 5000) {
  if (statsIntervalId) return;
  statsIntervalId = setInterval(async () => {
    const container = document.getElementById('stats-container');
    if (!container) return;
    container.innerHTML = '';
    // Show own identity
    const myRoleLabel = myRole === 'host' ? '🎤主播' : '🎧听众';
    const meEl = document.createElement('div');
    meEl.style.cssText = 'padding:4px 8px;margin-bottom:8px;font-size:12px;color:var(--text-muted)';
    meEl.textContent = `我的 ID: ${myId || '—'}  ${myRoleLabel}`;
    container.appendChild(meEl);

    const keys = Object.keys(pcMap);
    if (keys.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.textContent = '无连接';
      emptyEl.style.cssText = 'font-size:13px;color:var(--text-muted)';
      container.appendChild(emptyEl);
      return;
    }
    const allRaw = {};
    for (const [id, pc] of Object.entries(pcMap)) {
      try {
        const stats = await pc.getStats();
        // collect raw reports for display
        const reports = {};
        stats.forEach(r => { reports[r.id || (r.type+'-'+Math.random().toString(36).slice(2,6))] = r; });
        allRaw[id] = reports;
        
        // Collect ALL inbound/outbound RTP tracks, not just the first one
        const inbounds = [];
        const outbounds = [];
        let pair = null;
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') inbounds.push(r);
          if (r.type === 'outbound-rtp' && r.kind === 'audio') outbounds.push(r);
          if (r.type === 'candidate-pair' && r.nominated) pair = r;
        });
        
        // Use first of each for backward compatibility, but prepare data for all
        const inbound = inbounds.length > 0 ? inbounds[0] : null;
        const outbound = outbounds.length > 0 ? outbounds[0] : null;

        const loss = inbound ? ((inbound.packetsLost||0) / Math.max(1, inbound.packetsReceived||0))*100 : 0;
        const rtt = pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime*1000) : 0;
        
        // Calculate bitrate for all inbound and outbound tracks separately
        const last = _lastStats[id] || { inTracks: {}, outTracks: {} };
        let totalInBitrate = 0;
        let totalOutBitrate = 0;
        const inBitrates = {};
        const outBitrates = {};
        
        // Calculate bitrate for each inbound RTP track
        inbounds.forEach((ib, idx) => {
          const trackKey = `in_${idx}`;
          const lastTrack = last.inTracks[trackKey] || {};
          let bitrate = 0;
          if (ib && ib.bytesReceived && ib.timestamp) {
            if (lastTrack.bytes && lastTrack.ts && ib.timestamp > lastTrack.ts) {
              const deltaBytes = ib.bytesReceived - lastTrack.bytes;
              const deltaSec = (ib.timestamp - lastTrack.ts) / 1000;
              if (deltaSec > 0 && deltaBytes >= 0) bitrate = Math.round((deltaBytes * 8) / 1000 / deltaSec);
            }
            lastTrack.bytes = ib.bytesReceived;
            lastTrack.ts = ib.timestamp;
          }
          inBitrates[trackKey] = bitrate;
          totalInBitrate += bitrate;
          last.inTracks[trackKey] = lastTrack;
        });
        
        // Calculate bitrate for each outbound RTP track
        outbounds.forEach((ob, idx) => {
          const trackKey = `out_${idx}`;
          const lastTrack = last.outTracks[trackKey] || {};
          let bitrate = 0;
          if (ob && ob.bytesSent && ob.timestamp) {
            if (lastTrack.bytes && lastTrack.ts && ob.timestamp > lastTrack.ts) {
              const deltaBytes = ob.bytesSent - lastTrack.bytes;
              const deltaSec = (ob.timestamp - lastTrack.ts) / 1000;
              if (deltaSec > 0 && deltaBytes >= 0) bitrate = Math.round((deltaBytes * 8) / 1000 / deltaSec);
            }
            lastTrack.bytes = ob.bytesSent;
            lastTrack.ts = ob.timestamp;
          }
          outBitrates[trackKey] = bitrate;
          totalOutBitrate += bitrate;
          last.outTracks[trackKey] = lastTrack;
        });
        
        _lastStats[id] = last;

        // Extract additional metrics
        const outCodec = outbound && outbound.mimeType ? outbound.mimeType.split('/').pop() : 'unknown';
        const inCodec = inbound && inbound.mimeType ? inbound.mimeType.split('/').pop() : 'unknown';
        const jitter = inbound && inbound.jitter ? (inbound.jitter*1000).toFixed(2) : 'N/A';
        // Average time audio spent in the jitter buffer (ms).  If this bounces
        // near 0, the buffer is too small — packets arrive too late for it.
        const jbDelay = inbound && inbound.jitterBufferEmittedCount
          ? ((inbound.jitterBufferDelay || 0) / inbound.jitterBufferEmittedCount * 1000).toFixed(0)
          : 'N/A';
        const audioLevel = inbound && inbound.audioLevel !== undefined ? (inbound.audioLevel*100).toFixed(1) : 'N/A';
        const availableOutBitrate = pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate/1000) : 'N/A';
        const connState = pc.connectionState || 'N/A';
        const iceState = pc.iceConnectionState || 'N/A';
        
        // Summarize on first line
        const el = document.createElement('div');
        el.style.padding = '8px';
        el.style.marginBottom = '6px';
        el.style.borderLeft = '3px solid #4ade80';
        el.style.background = 'rgba(255,255,255,.03)';
        el.style.borderRadius = '6px';
        
        // Add track count information
        const senderCount = pc._senders ? Object.keys(pc._senders).filter(k => pc._senders[k]).length : 0;
        const inboundCount = inbounds.length;
        const outboundCount = outbounds.length;
        
        const peerRole = peerRoles[id] || 'unknown';
        const roleBadge = peerRole === 'host' ? '🎤主播' : '🎧听众';
        const firstLine = `<strong>peer ${id}</strong> (${roleBadge}) | 连接: ${connState} | ICE: ${iceState} | 📡 发送${senderCount}轨 | 📨 收${inboundCount}轨 | 📤 送${outboundCount}轨`;
        const secondLine = `📊 Loss: ${loss.toFixed(2)}% | RTT: ${rtt}ms | 抖动: ${jitter}ms | 缓冲: ${jbDelay}ms`;
        
        // Format track bitrates
        const outBitsList = Object.keys(outBitrates).map(k => outBitrates[k]).join(',');
        const inBitsList = Object.keys(inBitrates).map(k => inBitrates[k]).join(',');
        const thirdLine = outbounds.length > 1 || inbounds.length > 1
          ? `📤 Out: [${outBitsList}] kbps | 📥 In: [${inBitsList}] kbps`
          : `📤 Out: ${totalOutBitrate}kbps (${outCodec}) | 📥 In: ${totalInBitrate}kbps (${inCodec})`;
        const fourthLine = `🔊 Level: ${audioLevel}% | 可用: ${availableOutBitrate} kbps`;
        
        // Calculate total bytes and packets from all tracks
        let totalInBytes = 0, totalInPackets = 0, totalOutBytes = 0, totalOutPackets = 0;
        inbounds.forEach(ib => {
          if (ib.bytesReceived) totalInBytes += ib.bytesReceived;
          if (ib.packetsReceived) totalInPackets += ib.packetsReceived;
        });
        outbounds.forEach(ob => {
          if (ob.bytesSent) totalOutBytes += ob.bytesSent;
          if (ob.packetsSent) totalOutPackets += ob.packetsSent;
        });
        const fifthLine = `📨 收: ${(totalInBytes/1024).toFixed(1)}KB (${totalInPackets}包) | 📬 发: ${(totalOutBytes/1024).toFixed(1)}KB (${totalOutPackets}包)`;
        el.innerHTML = `${firstLine}<br/>${secondLine}<br/>${thirdLine}<br/>${fourthLine}<br/>${fifthLine}`;
        container.appendChild(el);
      } catch (e) {
        const el = document.createElement('div');
        el.style.color = '#f87171';
        const msg = e && e.message ? e.message : String(e);
        el.textContent = `peer ${id}: stats error: ${msg}`;
        container.appendChild(el);
        if (statsRawEl) {
          statsRawEl.textContent = `stats error for peer ${id}: ${e && e.stack ? e.stack : msg}`;
        }
        console.error('stats error for peer', id, e);
      }
    }
    if (statsRawEl) statsRawEl.textContent = JSON.stringify(allRaw, null, 2);
  }, intervalMs);
}

function stopStatsPolling() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
}

async function enableMic() {
  if (!navigator.mediaDevices) {
    throw new Error('当前页面非安全上下文（需 localhost 或 HTTPS），无法访问麦克风。');
  }
  if (micEnabled) {
    return;
  }

  await ensureAudioPipeline();
  // request higher-quality capture when possible
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 48000, channelCount: 2 } });
  } catch (e) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  connectMediaStreamToGain(micStream, micGainNode, 'mic');
  micGainNode.gain.value = 1;
  micEnabled = true;
  // If peers were already connected before mic was on, push the track now.
  // addTrack triggers onnegotiationneeded → re-offer with audio.
  const micTrack = micStream.getAudioTracks()[0];
  if (micTrack) {
    for (const [peerId, pc] of Object.entries(pcMap)) {
      if (pc._senders && pc._senders.mic) continue;
      pc._senders = pc._senders || {};
      const sender = pc.addTrack(micTrack, micStream);
      pc._senders.mic = sender;
      try {
        if (sender && sender.getParameters) {
          const params = sender.getParameters();
          params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
          params.encodings[0].maxBitrate = 16000;
          sender.setParameters(params).catch(() => {});
        }
      } catch (_) {}
    }
  }
  refreshLocalPreview();
  updateStatus();
}

function disableMic() {
  if (!micEnabled) {
    return;
  }

  micEnabled = false;
  if (micGainNode) {
    micGainNode.gain.value = 0;
  }
  detachSourceNodes('mic');
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  refreshLocalPreview();
  updateStatus();
}

async function enableSystemAudio() {
  if (!navigator.mediaDevices) {
    throw new Error('当前页面非安全上下文（需 localhost 或 HTTPS），无法捕获系统音频。');
  }
  if (systemEnabled) {
    return;
  }

  await ensureAudioPipeline();

  // Reassure users: video is never transmitted — only audio is captured.
  alert('请选择要共享的桌面或窗口。\n\n✅ 勾选底部"共享系统音频"或"共享标签页音频"\n🛡️ 画面仅用于系统弹出选择框，所有视频数据会被立即丢弃，不会传输或录制。');

  const captureStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    }
  });

  // Immediately discard the video track — we only want system audio.
  // This proves to the user that we never capture their screen content.
  captureStream.getVideoTracks().forEach(t => t.stop());

  const audioTrack = getAudioTrack(captureStream);

  if (!audioTrack) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error('未获取到系统声音，请在共享窗口时勾选”共享音频”。');
  }

  systemStream = captureStream;
  systemEnabled = true;
  console.log(`[enableSystemAudio] System audio enabled, pcMap has ${Object.keys(pcMap).length} peers`);
  connectMediaStreamToGain(systemStream, systemGainNode, 'system');
  systemGainNode.gain.value = 1;
  // dynamically add system sender to all existing peers
  for (const [id, pc] of Object.entries(pcMap)) {
    console.log(`[enableSystemAudio] Adding system sender to peer ${id}`);
    addSystemAudioSender(pc);
  }
  captureStream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (systemEnabled) {
        disableSystemAudio();
      }
    }, { once: true });
  });
  refreshLocalPreview();
  updateStatus();
}

function disableSystemAudio() {
  if (!systemEnabled) {
    return;
  }

  systemEnabled = false;
  if (systemGainNode) {
    systemGainNode.gain.value = 0;
  }
  // dynamically remove system sender from all existing peers
  for (const pc of Object.values(pcMap)) {
    removeSystemAudioSender(pc);
  }
  detachSourceNodes('system');
  if (systemStream) {
    systemStream.getTracks().forEach((track) => track.stop());
    systemStream = null;
  }
  refreshLocalPreview();
  updateStatus();
}

function connectWs() {
  const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
  console.log('connectWs URL:', url, 'location.host:', location.host, 'location.protocol:', location.protocol);
  ws = new WebSocket(url);
  console.log('WebSocket created, readyState:', ws.readyState);
  ws.onopen = () => {
    wsReconnectAttempts = 0;
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    // If reconnecting, tear down stale PCs so the fresh joined creates new ones.
    if (joined) {
      resetPeerConnections();
    }
    ws.send(JSON.stringify({ type: 'join', room: roomInput.value, role: myRole }));
  };
  ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'joined') {
      myId = data.id;
      joined = true;
      document.getElementById('room-list').classList.add('disabled');
      // Persist room+role so a page refresh auto-rejoins
      try { localStorage.setItem('p2p_room', roomInput.value); } catch (_) {}
      try { localStorage.setItem('p2p_role', myRole); } catch (_) {}
      // Update URL hash so the user can copy & share the link
      try { history.replaceState(null, '', '#' + roomInput.value); } catch (_) {}
      if (data.roles) peerRoles = { ...data.roles };
      // Load accumulated reaction counts from server
      if (data.reactionCounts) {
        Object.assign(reactionCounts, data.reactionCounts);
        for (const [emoji, count] of Object.entries(data.reactionCounts)) {
          const btn = document.querySelector(`#reaction-bar button[data-emoji="${emoji}"]`);
          if (btn) btn.querySelector('.rc').textContent = count;
        }
      }

      // Use the server-assigned role — may differ from what was requested
      // if a host already exists in the room.
      if (data.yourRole) {
        if (myRole === 'host' && data.yourRole === 'listener') {
          statusEl.textContent = '该电台已有主播，已自动切换为听众模式。';
          // Sync the role selector buttons
          const hostBtn = document.getElementById('role-host');
          const listenerBtn = document.getElementById('role-listener');
          if (hostBtn && listenerBtn) {
            hostBtn.classList.remove('active');
            hostBtn.classList.add('locked');
            listenerBtn.classList.add('active');
          }
        }
        myRole = data.yourRole;
      }

      // Role-specific setup
      if (myRole === 'host') {
        document.getElementById('host-controls').style.display = 'inline';
        document.getElementById('host-meters').style.display = 'block';
        document.getElementById('listener-meters').style.display = 'none';
        try {
          await ensureAudioPipeline();
          startInputMeter();
        } catch (error) {
          console.error(error);
          statusEl.textContent = '音频初始化失败：' + error.message;
        }
        toggleMicBtn.disabled = false;
        toggleSystemBtn.disabled = false;
      } else {
        document.getElementById('host-controls').style.display = 'none';
        document.getElementById('host-meters').style.display = 'none';
        document.getElementById('listener-meters').style.display = 'block';
        if (!listenerAudioContext || listenerAudioContext.state === 'closed') {
          listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        listenerAudioContext.resume().catch(() => {});
      }
      updateStatus();

      // switch join → leave button
      joinBtn.classList.add('hidden');
      const leaveBtn = document.getElementById('leave');
      if (leaveBtn) leaveBtn.classList.remove('hidden');

      // show reaction bar, firework button (host only), mute button
      document.getElementById('reaction-bar').style.display = 'flex';
      const fwBtn = document.getElementById('firework-btn');
      if (fwBtn) fwBtn.classList.toggle('hidden', myRole !== 'host');
      if (muteBtn) muteBtn.classList.remove('hidden');

      // Refresh room list immediately so counts update without waiting for poll
      fetchRooms();

      startStatsPolling();

      const peers = data.peers;
      for (const peerId of peers) {
        await createOffer(peerId);
      }
    } else if (data.type === 'peer-joined') {
      if (data.role) peerRoles[data.id] = data.role;
      return;
    } else if (data.type === 'offer') {
      await handleOffer(data.from, data.sdp);
    } else if (data.type === 'answer') {
      const pc = pcMap[data.from];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } catch (e) {
          console.error(`[${data.from}] Error setting remote answer:`, e);
        }
      }
    } else if (data.type === 'ice') {
      const pc = pcMap[data.from];
      if (pc && data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
      }
    } else if (data.type === 'firework') {
      statusEl.textContent = '🎆 主播放了一个烟花！';
      try { launchFireworks(); } catch (e) { console.error('firework:', e); }
      setTimeout(() => updateStatus(), 3000);
    } else if (data.type === 'reaction') {
      // Server count is authoritative — sync then show
      if (data.count !== undefined) reactionCounts[data.emoji] = data.count;
      const btn = document.querySelector(`#reaction-bar button[data-emoji="${data.emoji}"]`);
      if (btn) btn.querySelector('.rc').textContent = reactionCounts[data.emoji];
      showReaction(data.emoji);
    } else if (data.type === 'peer-left') {
      delete peerRoles[data.id];
      closePeer(data.id);
    }
  };
  ws.onclose = (ev) => {
    console.warn('WebSocket closed', { code: ev?.code, reason: ev?.reason, wasClean: ev?.wasClean, joined });
    if (!joined) return; // deliberate leave or never joined — don't reconnect
    scheduleWsReconnect();
  };
  ws.onerror = (ev) => {
    console.error('WebSocket error', ev);
  };
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
  wsReconnectAttempts++;
  statusEl.textContent = `WebSocket 断开，${(delay / 1000).toFixed(0)}s 后重连…（第 ${wsReconnectAttempts} 次）`;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, delay);
}

function makePC(peerId) {
  const pc = new RTCPeerConnection(servers);
  pc._negotiationInProgress = false;
  if (myRole === 'host') {
    attachCurrentSources(pc);
    // if system audio is already enabled, add system sender immediately
    if (systemEnabled) {
      addSystemAudioSender(pc);
    }
  }

  // If we have no audio tracks to send, create a receive-only transceiver.
  // This ensures the SDP always has an audio m-line — critical for Safari
  // which may reject incoming audio if the offer doesn't declare audio capability.
  const hasAudioSender = pc.getSenders().some(s => s.track && s.track.kind === 'audio');
  if (!hasAudioSender) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'ice', to: peerId, candidate: e.candidate }));
    }
  };

  // ICE connection failure → automatic restart
  pc.oniceconnectionstatechange = () => {
    console.log(`[${peerId}] ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.log(`[${peerId}] ICE failed, attempting restart`);
      restartIce(pc, peerId);
    }
  };

  // Handle negotiationneeded event
  pc.onnegotiationneeded = async () => {
    if (pc._negotiationInProgress) {
      console.log(`[${peerId}] negotiation already in progress, skipping`);
      return;
    }
    try {
      pc._negotiationInProgress = true;
      console.log(`[${peerId}] onnegotiationneeded triggered`);
      const offer = await pc.createOffer();
      offer.sdp = mungeOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`[${peerId}] Sending renegotiation offer`);
        ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
      }
    } catch (e) {
      console.error(`[${peerId}] negotiation error:`, e);
    } finally {
      pc._negotiationInProgress = false;
    }
  };
  
  pc.ontrack = async (e) => {
    const stream = e.streams[0];
    console.log(`[${peerId}] ontrack fired, stream has ${stream.getAudioTracks().length} audio tracks`);
    if (e.receiver && e.receiver.playoutDelayHint !== undefined) {
      try {
        e.receiver.playoutDelayHint = { min: 0.15, max: 0.5 };
        console.log(`[${peerId}] playoutDelayHint set to {min:150ms, max:500ms}`);
      } catch (_) {}
    }

    // ── Playback path selection ──────────────────────────────────────
    // Listeners always use Web Audio API — renegotiation-triggered ontrack
    // is NOT exempt from Chrome's autoplay policy, so <audio>.play() is
    // silently blocked.  Web Audio bypasses this completely.
    // Hosts use <audio> (works for initial ontrack) to avoid double-playback
    // with the send-pipeline AudioContext.
    const isIOSSafari = /Safari/i.test(navigator.userAgent) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/i.test(navigator.userAgent) &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
       (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

    const useWebAudio = isIOSSafari;

    if (useWebAudio) {
      try {
        if (remoteAudioSources[peerId]) {
          remoteAudioSources[peerId].disconnect();
        }
        // Host on iOS Safari reuses the send-pipeline audioContext;
        // everyone else uses a dedicated playback context.
        let ctx = (myRole === 'host') ? audioContext : null;
        if (!ctx) {
          if (!listenerAudioContext) {
            listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          ctx = listenerAudioContext;
        }
        if (ctx && ctx.state !== 'running') {
          await ctx.resume().catch(() => {});
        }
        if (ctx && ctx.state === 'running') {
          const source = ctx.createMediaStreamSource(stream);
          ensureListenerGain();
          source.connect(listenerGainNode || ctx.destination);
          remoteAudioSources[peerId] = source;
          console.log(`[${peerId}] playing via Web Audio (role=${myRole})`);
        }
      } catch (err) {
        console.warn(`[${peerId}] Web Audio playback failed`, err);
      }

      // Remove any stale <audio> element to prevent double playback
      const oldAudio = document.getElementById('audio-' + peerId);
      if (oldAudio) oldAudio.remove();
    } else {
      // Non-iOS browsers: <audio> element first.  It works reliably for
      // initial ontrack; if blocked (renegotiation case), fall back to Web Audio.
      let audio = document.getElementById('audio-' + peerId);
      if (audio) audio.remove();
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.playsInline = true;
      audio.setAttribute('playsinline', '');
      remotes.appendChild(audio);
      audio.srcObject = stream;

      const played = await audio.play().then(() => true).catch(() => false);
      if (!played) {
        // Autoplay blocked (typically renegotiation ontrack) — use Web Audio fallback
        console.log(`[${peerId}] audio.play() blocked, switching to Web Audio`);
        audio.remove();
        try {
          if (remoteAudioSources[peerId]) remoteAudioSources[peerId].disconnect();
          if (!listenerAudioContext || listenerAudioContext.state === 'closed') {
            listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          if (listenerAudioContext.state !== 'running') {
            listenerAudioContext.resume().catch(() => {}); // fire-and-forget — Safari hangs on await
          }
          // Always connect; if ctx is suspended, audio starts when user interacts
          {
            const source = listenerAudioContext.createMediaStreamSource(stream);
            ensureListenerGain();
            source.connect(listenerGainNode || listenerAudioContext.destination);
            remoteAudioSources[peerId] = source;
            console.log(`[${peerId}] playing via Web Audio fallback`);
          }
        } catch (err) {
          console.warn(`[${peerId}] Web Audio fallback failed`, err);
        }
      } else {
        // Clean up any stale Web Audio source (avoid double playback)
        if (remoteAudioSources[peerId]) {
          try { remoteAudioSources[peerId].disconnect(); } catch(e) {}
          delete remoteAudioSources[peerId];
        }
      }
    }

    registerPlaybackStream(peerId, stream).catch((error) => {
      console.error('Failed to register playback stream', error);
    });
  };
  pcMap[peerId] = pc;
  return pc;
}

async function createOffer(peerId) {
  let pc = pcMap[peerId];
  if (!pc) {
    pc = makePC(peerId);
  }
  try {
    pc._negotiationInProgress = true;
    const offer = await pc.createOffer();
    offer.sdp = mungeOpusSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
    console.log(`[createOffer] Sent initial offer to ${peerId}`);
  } catch (e) {
    console.error(`[createOffer] Error creating offer for ${peerId}:`, e);
  } finally {
    pc._negotiationInProgress = false;
  }
}

async function handleOffer(from, sdp) {
  let pc = pcMap[from];
  if (!pc) {
    pc = makePC(from);
  }
  try {
    pc._negotiationInProgress = true;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    answer.sdp = mungeOpusSdp(answer.sdp);
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', to: from, sdp: pc.localDescription }));
  } catch (e) {
    console.error(`[handleOffer] Error handling offer from ${from}:`, e);
  } finally {
    pc._negotiationInProgress = false;
  }
}

function closePeer(id) {
  const pc = pcMap[id];
  if (pc) {
    pc.close();
    delete pcMap[id];
  }
  if (remoteAudioSources[id]) {
    try { remoteAudioSources[id].disconnect(); } catch(e) {}
    delete remoteAudioSources[id];
  }
  unregisterPlaybackStream(id);
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.remove();
}

// Tear down all peer connections and audio state (called before WS reconnect).
function resetPeerConnections() {
  for (const [id, pc] of Object.entries(pcMap)) {
    pc.close();
  }
  pcMap = {};
  window.__pcMap = pcMap;
  for (const id of Object.keys(remoteAudioSources)) {
    try { remoteAudioSources[id].disconnect(); } catch(e) {}
    delete remoteAudioSources[id];
  }
  document.querySelectorAll('#remotes audio').forEach(el => el.remove());
  for (const [id, source] of playbackStreamSources) {
    try { source.disconnect(); } catch(e) {}
  }
  playbackStreamSources.clear();
  setPlaybackMeter(0, -120, false);
  peerRoles = {};
}

// ICE restart for a single PeerConnection that entered "failed" state.
async function restartIce(pc, peerId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    pc._negotiationInProgress = true;
    const offer = await pc.createOffer({ iceRestart: true });
    offer.sdp = mungeOpusSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
    console.log(`[${peerId}] ICE restart offer sent`);
  } catch (e) {
    console.error(`[${peerId}] ICE restart failed:`, e);
  } finally {
    pc._negotiationInProgress = false;
  }
}

joinBtn.onclick = async () => {
  if (joined) { console.warn('Already joined, ignoring click'); return; }
  const roomName = roomInput.value.trim();
  if (!roomName) { statusEl.textContent = '请输入电台名称'; return; }
  roomInput.value = roomName;
  joinBtn.disabled = true;
  document.querySelectorAll('#role-selector button, #room').forEach(el => el.disabled = true);
  document.getElementById('role-selector').style.opacity = '0.5';

  // Save intent immediately during user gesture — Safari may block
  // localStorage writes inside async WebSocket callbacks.
  try { localStorage.setItem('p2p_room', roomInput.value); } catch (_) {}
  try { localStorage.setItem('p2p_role', myRole); } catch (_) {}

  connectWs();
  // Role-specific setup is deferred to the 'joined' handler,
  // which knows the server-assigned role (may differ if host conflict).
};

const leaveBtn = document.getElementById('leave');
if (leaveBtn) {
  leaveBtn.addEventListener('click', () => { leaveRoom(); });
}

function leaveRoom() {
  // Clear saved room FIRST — if anything below throws and the page reloads,
  // we don't want to auto-rejoin.
  try { localStorage.removeItem('p2p_room'); } catch (_) {}
  try { localStorage.removeItem('p2p_role'); } catch (_) {}
  try { history.replaceState(null, '', location.pathname); } catch (_) {}

  try {
    // Prevent reconnect attempts
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    wsReconnectAttempts = 0;

    // Close WebSocket
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }

    // Close all peer connections
    resetPeerConnections();

    // Stop local streams
    if (micEnabled) disableMic();
    if (systemEnabled) disableSystemAudio();

    // Stop input meter
    stopInputMeter();

    // Close audio contexts
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      mixDestination = null; mixStream = null; mixTrack = null;
      micGainNode = null; systemGainNode = null;
      micAnalyser = null; systemAnalyser = null;
      micSourceNode = null; systemSourceNode = null;
    }
    if (listenerAudioContext) {
      listenerAudioContext.close();
      listenerAudioContext = null;
      listenerGainNode = null;
    }
    if (playbackAudioContext) {
      playbackAudioContext.close();
      playbackAudioContext = null;
      playbackAnalyser = null;
      if (playbackMeterRaf) { cancelAnimationFrame(playbackMeterRaf); playbackMeterRaf = 0; }
    }

    // Remove local preview audio element so ensureAudioPipeline creates a fresh one
    if (localPreviewAudio) {
      try { localPreviewAudio.remove(); } catch (_) {}
      localPreviewAudio = null;
    }

    // Reset state
    joined = false;
    myId = undefined;
    _lastStats = {};

    // Stop polling
    stopStatsPolling();

    // Clear UI
    const container = document.getElementById('stats-container');
    if (container) container.innerHTML = '无连接';
    if (statsRawEl) statsRawEl.textContent = '等待数据...';

    // Restore join controls
    joinBtn.classList.remove('hidden');
    if (leaveBtn) leaveBtn.classList.add('hidden');
    joinBtn.disabled = false;
    document.getElementById('room-list').classList.remove('disabled');
    document.querySelectorAll('#role-selector button, #room').forEach(el => el.disabled = false);
    document.getElementById('role-host').classList.remove('locked');
    document.getElementById('role-selector').style.opacity = '1';
    document.getElementById('host-controls').style.display = 'none';
    document.getElementById('host-meters').style.display = 'none';
    document.getElementById('listener-meters').style.display = 'block';
    document.getElementById('reaction-bar').style.display = 'none';
    if (muteBtn) { muteBtn.classList.add('hidden'); muteBtn.textContent = '🔊 收听中'; muteBtn.classList.remove('muted'); }
    listenerMuted = false;
    if (listenerGainNode) listenerGainNode.gain.value = 1;
    // reset reaction counts
    for (const k of Object.keys(reactionCounts)) reactionCounts[k] = 0;
    document.querySelectorAll('#reaction-bar .rc').forEach(el => el.textContent = '0');
    toggleMicBtn.disabled = true;
    toggleSystemBtn.disabled = true;

    setPlaybackMeter(0, -120, false);
    updateStatus();
    fetchRooms();
  } catch (e) {
    console.error('leaveRoom error:', e);
    // Force page reload as last resort
    location.reload();
  }
}

toggleMicBtn.onclick = async () => {
  try {
    if (micEnabled) {
      disableMic();
    } else {
      await enableMic();
    }
  } catch (error) {
    console.error(error);
    statusEl.textContent = '麦克风开启失败：' + error.message;
  }
};

toggleSystemBtn.onclick = async () => {
  try {
    if (systemEnabled) {
      disableSystemAudio();
    } else {
      await enableSystemAudio();
    }
  } catch (error) {
    console.error(error);
    statusEl.textContent = '系统声音开启失败：' + error.message;
  }
};

// role selector
document.getElementById('role-host').addEventListener('click', () => {
  if (document.getElementById('role-host').disabled) return;
  document.getElementById('role-host').classList.add('active');
  document.getElementById('role-listener').classList.remove('active');
  myRole = 'host';
});
document.getElementById('role-listener').addEventListener('click', () => {
  document.getElementById('role-listener').classList.add('active');
  document.getElementById('role-host').classList.remove('active');
  myRole = 'listener';
});

// When user types a room name, check if it has a host and lock accordingly
roomInput.addEventListener('input', () => {
  updateRoleSelectorForRoom(roomInput.value.trim());
});

// reaction bar
document.querySelectorAll('#reaction-bar button[data-emoji]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'reaction', emoji: btn.dataset.emoji }));
  });
});

// firework button (host only)
const fwBtn = document.getElementById('firework-btn');
if (fwBtn) {
  fwBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'firework' }));
    launchFireworks(); // show locally too
  });
}

// mute button
const muteBtn = document.getElementById('mute-btn');
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    listenerMuted = !listenerMuted;
    if (listenerGainNode) listenerGainNode.gain.value = listenerMuted ? 0 : 1;
    document.querySelectorAll('#remotes audio').forEach(a => { a.muted = listenerMuted; });
    muteBtn.textContent = listenerMuted ? '🔇 已静音' : '🔊 收听中';
    muteBtn.classList.toggle('muted', listenerMuted);
  });
}

// copy shareable link
document.getElementById('copy-link').addEventListener('click', async () => {
  const url = location.origin + '/' + '#' + encodeURIComponent(roomInput.value.trim() || 'test');
  try {
    await navigator.clipboard.writeText(url);
    statusEl.textContent = '链接已复制：' + url;
    setTimeout(() => updateStatus(), 3000);
  } catch (_) {
    statusEl.textContent = '复制失败，请手动复制地址栏链接';
  }
});

toggleMicBtn.disabled = true;
toggleSystemBtn.disabled = true;
updateAccessUrl();
// If URL has a hash (shared link), pre-fill the room name
const hashRoom = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch(_) { return ''; } })();
if (hashRoom && !joined) {
  roomInput.value = hashRoom;
  updateRoleSelectorForRoom(hashRoom);
}

updateStatus();
startRoomPolling();

// Auto-rejoin on page refresh.
async function tryAutoRejoin() {
  try {
    if (joined) return;

    // If opened via a shared link (#hash), that's a fresh intent — don't restore stale localStorage.
    const hashRoom = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch(_) { return ''; } })();
    if (hashRoom) return;

    let savedRoom, savedRole;
    try { savedRoom = localStorage.getItem('p2p_room'); } catch (_) {}
    try { savedRole = localStorage.getItem('p2p_role'); } catch (_) {}
    if (!savedRoom || !savedRole) return;

    roomInput.value = savedRoom;
    myRole = savedRole;

    if (savedRole === 'host') {
      document.getElementById('role-host').classList.add('active');
      document.getElementById('role-listener').classList.remove('active');
    } else {
      document.getElementById('role-listener').classList.add('active');
      document.getElementById('role-host').classList.remove('active');
      if (!listenerAudioContext || listenerAudioContext.state === 'closed') {
        try { listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
      }
      if (listenerAudioContext) {
        listenerAudioContext.resume().catch(() => {});
      }
    }

    // Don't auto-click join — let the user decide. Pre-fill is enough.
    // If they click "加入" they'll resume normally (with user gesture).
    // If they want to leave, the saved data will be cleared on click.
    statusEl.textContent = '页面已刷新，表单已恢复。点击"加入"继续。';
  } catch (e) {
    console.error('tryAutoRejoin:', e);
  }
}

// Run on pageshow (Safari) or immediately if page already loaded.
// Handle bfcache: if page is restored from back/forward cache, JavaScript state
// (including `joined`, `ws`, etc.) is preserved but stale — reset to safe defaults.
if (document.readyState === 'complete') {
  tryAutoRejoin();
} else {
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      // bfcache restore — reset stale state
      joined = false;
      myId = undefined;
      ws = null;
      wsReconnectAttempts = 0;
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    }
    tryAutoRejoin();
  });
}

// Notify server before page unload so stale host is cleaned up immediately.
// Prevents a refresh race where the old host ID is still in the room when
// the new join arrives, causing a downgrade to listener.
window.addEventListener('beforeunload', () => {
  if (joined && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'leave' }));
  }
});

// Debug helper — type __debug() in the console to inspect internal state.
window.__debug = () => {
  const state = {
    joined,
    myId,
    myRole,
    ws: ws ? (ws.readyState === WebSocket.OPEN ? 'OPEN' :
              ws.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
              ws.readyState === WebSocket.CLOSING ? 'CLOSING' :
              ws.readyState === WebSocket.CLOSED ? 'CLOSED' : ws.readyState) : null,
    wsReconnectAttempts,
    wsReconnectTimer: wsReconnectTimer ? 'active' : null,
    micEnabled,
    systemEnabled,
    listenerMuted,
    // localStorage
    p2p_room: (() => { try { return localStorage.getItem('p2p_room'); } catch(_) { return null; } })(),
    p2p_role: (() => { try { return localStorage.getItem('p2p_role'); } catch(_) { return null; } })(),
    // URL hash
    hash: location.hash,
  };
  console.table(state);
  return state;
};

})();
