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
let playbackAudioContext = null;
let playbackAnalyser = null;
let playbackMeterRaf = 0;
let playbackStreamSources = new Map();

const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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
    })
    .catch(() => {
      accessUrlEl.textContent = `当前访问地址：${location.origin}`;
    });
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
    micGainNode.gain.value = 0;
    systemGainNode.gain.value = 0;
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
    playbackMeterTextEl.textContent = `${levelPercent.toFixed(0)}% / ${dbfs.toFixed(1)} dBFS`;
  }

  if (playbackMeterStateEl) {
    playbackMeterStateEl.textContent = isActive ? '正在播放' : '未检测到播放声音';
  }
}

async function ensurePlaybackMeter() {
  if (!playbackAudioContext) {
    playbackAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    playbackAnalyser = playbackAudioContext.createAnalyser();
    playbackAnalyser.fftSize = 2048;
    playbackAnalyser.smoothingTimeConstant = 0.85;
    await playbackAudioContext.resume();
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
  sourceNode.connect(gainNode);
  if (kind === 'mic') {
    micSourceNode = sourceNode;
  } else {
    systemSourceNode = sourceNode;
  }
}

function updateStatus() {
  toggleMicBtn.textContent = micEnabled ? '麦克风：开' : '麦克风：关';
  toggleSystemBtn.textContent = systemEnabled ? '系统声音：开' : '系统声音：关';
  statusEl.textContent = `麦克风：${micEnabled ? '开' : '关'}，系统声音：${systemEnabled ? '开' : '关'}。`;
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
  if (mixTrack && mixStream) {
    const sender = pc.addTrack(mixTrack, mixStream);
    pc._senders.mix = sender;
    // try to request a higher audio bitrate (e.g., 192 kbps)
    try {
      if (sender && sender.getParameters) {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = 192000; // 192 kbps
        sender.setParameters(params).catch((e) => console.warn('setParameters failed', e));
      }
    } catch (e) {
      console.warn('setParameters not supported', e);
    }
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
    const keys = Object.keys(pcMap);
    if (keys.length === 0) {
      container.textContent = '无连接';
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
        let inbound = null, outbound = null, pair = null;
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
          if (r.type === 'outbound-rtp' && r.kind === 'audio') outbound = r;
          if (r.type === 'candidate-pair' && r.nominated) pair = r;
        });

        const loss = inbound ? ((inbound.packetsLost||0) / Math.max(1, inbound.packetsReceived||0))*100 : 0;
        const rtt = pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime*1000) : 0;
        let outBitrate = 0;
        let inBitrate = 0;
        const last = _lastStats[id] || {};
        if (outbound && outbound.bytesSent && outbound.timestamp) {
          if (last.outBytes && last.outTs && outbound.timestamp > last.outTs) {
            const deltaBytes = outbound.bytesSent - last.outBytes;
            const deltaSec = (outbound.timestamp - last.outTs) / 1000;
            if (deltaSec > 0 && deltaBytes >= 0) outBitrate = Math.round((deltaBytes * 8) / 1000 / deltaSec);
          }
          last.outBytes = outbound.bytesSent;
          last.outTs = outbound.timestamp;
        }
        if (inbound && inbound.bytesReceived && inbound.timestamp) {
          if (last.inBytes && last.inTs && inbound.timestamp > last.inTs) {
            const deltaBytes = inbound.bytesReceived - last.inBytes;
            const deltaSec = (inbound.timestamp - last.inTs) / 1000;
            if (deltaSec > 0 && deltaBytes >= 0) inBitrate = Math.round((deltaBytes * 8) / 1000 / deltaSec);
          }
          last.inBytes = inbound.bytesReceived;
          last.inTs = inbound.timestamp;
        }
        _lastStats[id] = last;

        const el = document.createElement('div');
        el.style.padding = '6px 8px';
        el.style.borderBottom = '1px solid #eee';
        el.innerHTML = `<strong>peer ${id}</strong>: loss=${loss.toFixed(2)}% rtt=${rtt}ms out=${outBitrate}kbps in=${inBitrate}kbps`;
        container.appendChild(el);
      } catch (e) {
        const el = document.createElement('div');
        el.style.color = 'crimson';
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
  if (systemEnabled) {
    return;
  }

  await ensureAudioPipeline();
  const captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTrack = getAudioTrack(captureStream);

  if (!audioTrack) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error('未获取到系统声音，请在共享窗口时勾选“共享音频”。');
  }

  systemStream = captureStream;
  systemEnabled = true;
  connectMediaStreamToGain(systemStream, systemGainNode, 'system');
  systemGainNode.gain.value = 1;
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
  detachSourceNodes('system');
  if (systemStream) {
    systemStream.getTracks().forEach((track) => track.stop());
    systemStream = null;
  }
  refreshLocalPreview();
  updateStatus();
}

function connectWs() {
  const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
  ws = new WebSocket(url);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomInput.value }));
  };
  ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'joined') {
      myId = data.id;
      const peers = data.peers;
      for (const peerId of peers) {
        await createOffer(peerId);
      }
    } else if (data.type === 'peer-joined') {
      return;
    } else if (data.type === 'offer') {
      await handleOffer(data.from, data.sdp);
    } else if (data.type === 'answer') {
      const pc = pcMap[data.from];
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice') {
      const pc = pcMap[data.from];
      if (pc && data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
      }
    } else if (data.type === 'peer-left') {
      closePeer(data.id);
    }
  };
}

function makePC(peerId) {
  const pc = new RTCPeerConnection(servers);
  attachCurrentSources(pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'ice', to: peerId, candidate: e.candidate }));
    }
  };
  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      remotes.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    registerPlaybackStream(peerId, e.streams[0]).catch((error) => {
      console.error('Failed to register playback stream', error);
    });
  };
  pcMap[peerId] = pc;
  return pc;
}

async function createOffer(peerId) {
  const pc = makePC(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
}

async function handleOffer(from, sdp) {
  const pc = makePC(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', to: from, sdp: pc.localDescription }));
}

function closePeer(id) {
  const pc = pcMap[id];
  if (pc) {
    pc.close();
    delete pcMap[id];
  }
  unregisterPlaybackStream(id);
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.remove();
}

joinBtn.onclick = async () => {
  joinBtn.disabled = true;
  connectWs();

  try {
    await ensureAudioPipeline();
    await enableMic();
  } catch (error) {
    console.error(error);
    statusEl.textContent = '已加入房间，但麦克风初始化失败：' + error.message + '。你仍然可以收听远端声音。';
  }

  joinBtn.disabled = true;
  toggleMicBtn.disabled = false;
  toggleSystemBtn.disabled = false;
  // start stats polling when joined
  startStatsPolling();
};

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

toggleMicBtn.disabled = true;
toggleSystemBtn.disabled = true;
updateAccessUrl();
updateStatus();

})();
