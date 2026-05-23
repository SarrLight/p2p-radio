import { dom, S } from './state.js';
import { updateStatus, setPlaybackMeter, ensureListenerGain } from './ui.js';

// ── Local preview element ──────────────────────────────────────────────
function ensureLocalPreview() {
  if (!S.localPreviewAudio) {
    S.localPreviewAudio = document.createElement('audio');
    S.localPreviewAudio.autoplay = true;
    S.localPreviewAudio.muted = true;
    dom.localContainer.appendChild(S.localPreviewAudio);
  }
}

// ── Audio pipeline ─────────────────────────────────────────────────────
export async function ensureAudioPipeline() {
  if (!S.audioContext) {
    try {
      S.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    } catch (e) {
      S.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    S.mixDestination = S.audioContext.createMediaStreamDestination();
    S.mixStream = S.mixDestination.stream;
    S.mixTrack = S.mixStream.getAudioTracks()[0] || null;
    S.micGainNode = S.audioContext.createGain();
    S.systemGainNode = S.audioContext.createGain();
    S.micAnalyser = S.audioContext.createAnalyser();
    S.systemAnalyser = S.audioContext.createAnalyser();
    S.micAnalyser.fftSize = 256;
    S.systemAnalyser.fftSize = 256;
    S.micAnalyser.smoothingTimeConstant = 0.7;
    S.systemAnalyser.smoothingTimeConstant = 0.7;
    S.micGainNode.gain.value = 0;
    S.systemGainNode.gain.value = 0;
    S.micAnalyser.connect(S.micGainNode);
    S.systemAnalyser.connect(S.systemGainNode);
    S.micGainNode.connect(S.mixDestination);
    S.systemGainNode.connect(S.mixDestination);
    await S.audioContext.resume();
  }
  ensureLocalPreview();
  S.localPreviewAudio.srcObject = S.mixStream;
}

// ── Input meters ───────────────────────────────────────────────────────
export function startInputMeter() {
  if (S.inputMeterRaf) return;
  const micFill = document.getElementById('mic-meter-fill');
  const micVal = document.getElementById('mic-meter-val');
  const sysFill = document.getElementById('sys-meter-fill');
  const sysVal = document.getElementById('sys-meter-val');

  const tick = () => {
    if (!S.micAnalyser && !S.systemAnalyser) { S.inputMeterRaf = 0; return; }

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

    updateOne(S.micAnalyser, micFill, micVal);
    updateOne(S.systemAnalyser, sysFill, sysVal);
    S.inputMeterRaf = requestAnimationFrame(tick);
  };
  S.inputMeterRaf = requestAnimationFrame(tick);
}

export function stopInputMeter() {
  if (S.inputMeterRaf) { cancelAnimationFrame(S.inputMeterRaf); S.inputMeterRaf = 0; }
  const ids = ['mic-meter-fill','sys-meter-fill','mic-meter-val','sys-meter-val'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id.endsWith('-fill')) el.style.width = '0%';
      else el.textContent = '-∞ dBFS';
    }
  });
}

// ── Playback meter ─────────────────────────────────────────────────────
async function ensurePlaybackMeter() {
  let ctx = S.playbackAudioContext;

  if (!ctx) {
    // On iOS/iPad, listenerAudioContext was created inside the join gesture
    // and is 'running'. Reuse it for the analyser instead of creating a new
    // AudioContext, which iOS would keep permanently suspended.
    ctx = S.listenerAudioContext;
    if (ctx && ctx.state !== 'closed') {
      S.playbackAudioContext = ctx;
    } else {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      S.playbackAudioContext = ctx;
      ctx.resume().catch(() => {});
    }
  }

  if (!S.playbackAnalyser) {
    S.playbackAnalyser = ctx.createAnalyser();
    S.playbackAnalyser.fftSize = 2048;
    S.playbackAnalyser.smoothingTimeConstant = 0.85;
  }

  if (!S.playbackMeterRaf) {
    const tick = () => {
      if (!S.playbackAnalyser) {
        S.playbackMeterRaf = 0;
        return;
      }
      const buffer = new Uint8Array(S.playbackAnalyser.fftSize);
      S.playbackAnalyser.getByteTimeDomainData(buffer);

      let sumSquares = 0;
      for (const value of buffer) {
        const normalized = (value - 128) / 128;
        sumSquares += normalized * normalized;
      }

      const rms = Math.sqrt(sumSquares / buffer.length);
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : -120;
      const levelPercent = Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100));
      setPlaybackMeter(levelPercent, dbfs, levelPercent > 3);
      S.playbackMeterRaf = window.requestAnimationFrame(tick);
    };
    S.playbackMeterRaf = window.requestAnimationFrame(tick);
  }
}

export async function registerPlaybackStream(peerId, stream) {
  await ensurePlaybackMeter();

  // On iOS, the Web Audio fallback in ontrack already injected the
  // analyser into the playback chain.  Don't create a second
  // MediaStreamSource from the same stream — iOS chokes on that.
  if (S._playbackAnalyserInjected) {
    // RAF loop is started by ensurePlaybackMeter above — just track the peer
    if (!S.playbackStreamSources.has(peerId)) {
      S.playbackStreamSources.set(peerId, null); // marker for cleanup
    }
    return;
  }

  const existingSource = S.playbackStreamSources.get(peerId);
  if (existingSource) {
    try { existingSource.disconnect(); } catch (e) {}
    S.playbackStreamSources.delete(peerId);
  }

  if (!stream) return;

  const sourceNode = S.playbackAudioContext.createMediaStreamSource(stream);
  sourceNode.connect(S.playbackAnalyser);
  S.playbackStreamSources.set(peerId, sourceNode);
}

export function unregisterPlaybackStream(peerId) {
  const sourceNode = S.playbackStreamSources.get(peerId);
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (e) {}
  }
  S.playbackStreamSources.delete(peerId);
  if (S.playbackStreamSources.size === 0) {
    setPlaybackMeter(0, -120, false);
  }
}

// ── Source node management ─────────────────────────────────────────────
function detachSourceNodes(kind) {
  if (kind === 'mic') {
    if (S.micSourceNode) {
      try { S.micSourceNode.disconnect(); } catch (e) {}
      S.micSourceNode = null;
    }
  } else if (kind === 'system') {
    if (S.systemSourceNode) {
      try { S.systemSourceNode.disconnect(); } catch (e) {}
      S.systemSourceNode = null;
    }
  }
}

function connectMediaStreamToGain(stream, gainNode, kind) {
  detachSourceNodes(kind);
  const sourceNode = S.audioContext.createMediaStreamSource(stream);
  const analyser = (kind === 'mic') ? S.micAnalyser : S.systemAnalyser;
  sourceNode.connect(analyser);
  if (kind === 'mic') {
    S.micSourceNode = sourceNode;
  } else {
    S.systemSourceNode = sourceNode;
  }
}

// ── Track helpers ──────────────────────────────────────────────────────
function getAudioTrack(stream) {
  if (!stream) return null;
  return stream.getAudioTracks()[0] || null;
}

function refreshLocalPreview() {
  ensureLocalPreview();
  const tracks = [];
  if (S.micStream) tracks.push(...S.micStream.getAudioTracks());
  if (S.systemStream) tracks.push(...S.systemStream.getAudioTracks());
  S.localPreviewAudio.srcObject = new MediaStream(tracks);
}

// ── Sender management ──────────────────────────────────────────────────
export function attachCurrentSources(pc) {
  pc._senders = {};
  if (S.micStream) {
    const micTrack = S.micStream.getAudioTracks()[0];
    if (micTrack) {
      const sender = pc.addTrack(micTrack, S.micStream);
      pc._senders.mic = sender;
      console.log(`[attachCurrentSources] Added mic sender to peer`);
      try {
        if (sender && sender.getParameters) {
          const params = sender.getParameters();
          params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
          params.encodings[0].maxBitrate = 16000;
          sender.setParameters(params).catch(() => {});
        }
      } catch (e) {}
    }
  } else {
    console.log(`[attachCurrentSources] micStream not ready yet`);
  }
}

export function addSystemAudioSender(pc) {
  if (!pc || !S.systemStream) {
    console.log(`[addSystemAudioSender] Skipped: pc=${!!pc}, systemStream=${!!S.systemStream}`);
    return;
  }
  try {
    if (pc._senders && pc._senders.system) {
      console.log(`[addSystemAudioSender] Already exists, skipping`);
      return;
    }
    const systemTrack = S.systemStream.getAudioTracks()[0];
    console.log(`[addSystemAudioSender] systemTrack=${!!systemTrack}`);
    if (systemTrack) {
      pc._senders = pc._senders || {};
      const sender = pc.addTrack(systemTrack, S.systemStream);
      pc._senders.system = sender;
      console.log(`[addSystemAudioSender] Added system sender to peer`);
      if (sender && sender.getParameters) {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = 320000;
        sender.setParameters(params).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('addSystemAudioSender failed', e);
  }
}

export function removeSystemAudioSender(pc) {
  if (!pc || !pc._senders || !pc._senders.system) {
    console.log(`[removeSystemAudioSender] Skipped: pc=${!!pc}, has system=${!!(pc && pc._senders && pc._senders.system)}`);
    return;
  }
  try {
    console.log(`[removeSystemAudioSender] Removing system sender`);
    pc.removeTrack(pc._senders.system);
    pc._senders.system = null;
    console.log(`[removeSystemAudioSender] Removed system sender`);
  } catch (e) {
    console.warn('removeSystemAudioSender failed', e);
  }
}

// ── Mic enable/disable ─────────────────────────────────────────────────
export async function enableMic() {
  if (!navigator.mediaDevices) {
    throw new Error('当前页面非安全上下文（需 localhost 或 HTTPS），无法访问麦克风。');
  }
  if (S.micEnabled) return;

  await ensureAudioPipeline();
  try {
    S.micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 48000, channelCount: 2 } });
  } catch (e) {
    S.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  connectMediaStreamToGain(S.micStream, S.micGainNode, 'mic');
  S.micGainNode.gain.value = 1;
  S.micEnabled = true;

  const micTrack = S.micStream.getAudioTracks()[0];
  if (micTrack) {
    for (const [peerId, pc] of Object.entries(S.pcMap)) {
      if (pc._senders && pc._senders.mic) continue;
      pc._senders = pc._senders || {};
      const sender = pc.addTrack(micTrack, S.micStream);
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

export function disableMic() {
  if (!S.micEnabled) return;
  S.micEnabled = false;
  if (S.micGainNode) S.micGainNode.gain.value = 0;
  detachSourceNodes('mic');
  if (S.micStream) {
    S.micStream.getTracks().forEach((track) => track.stop());
    S.micStream = null;
  }
  refreshLocalPreview();
  updateStatus();
}

export async function enableSystemAudio() {
  if (!navigator.mediaDevices) {
    throw new Error('当前页面非安全上下文（需 localhost 或 HTTPS），无法捕获系统音频。');
  }
  if (S.systemEnabled) return;

  await ensureAudioPipeline();

  alert('请选择要共享的桌面或窗口。\n\n✅ 勾选底部"共享系统音频"或"共享标签页音频"\n🛡️ 画面仅用于系统弹出选择框，所有视频数据会被立即丢弃，不会传输或录制。');

  const captureStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
  });

  captureStream.getVideoTracks().forEach(t => t.stop());
  const audioTrack = getAudioTrack(captureStream);

  if (!audioTrack) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error('未获取到系统声音，请在共享窗口时勾选"共享音频"。');
  }

  S.systemStream = captureStream;
  S.systemEnabled = true;
  console.log(`[enableSystemAudio] System audio enabled, pcMap has ${Object.keys(S.pcMap).length} peers`);
  connectMediaStreamToGain(S.systemStream, S.systemGainNode, 'system');
  S.systemGainNode.gain.value = 1;

  for (const [id, pc] of Object.entries(S.pcMap)) {
    console.log(`[enableSystemAudio] Adding system sender to peer ${id}`);
    addSystemAudioSender(pc);
  }

  captureStream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (S.systemEnabled) disableSystemAudio();
    }, { once: true });
  });

  refreshLocalPreview();
  updateStatus();
}

export function disableSystemAudio() {
  if (!S.systemEnabled) return;
  S.systemEnabled = false;
  if (S.systemGainNode) S.systemGainNode.gain.value = 0;

  for (const pc of Object.values(S.pcMap)) {
    removeSystemAudioSender(pc);
  }

  detachSourceNodes('system');
  if (S.systemStream) {
    S.systemStream.getTracks().forEach((track) => track.stop());
    S.systemStream = null;
  }
  refreshLocalPreview();
  updateStatus();
}
