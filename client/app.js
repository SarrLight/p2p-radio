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
let remoteAudioSources = {}; // peerId -> MediaStreamAudioSourceNode (for Safari-compatible playback)

// Local STUN first (embedded in signaling server – works without internet access),
// Google STUN as fallback for when clients are on different LANs.
const stunUrl = `stun:${location.hostname}:3478`;
const servers = {
  iceServers: [
    { urls: stunUrl },
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
        const audioLevel = inbound && inbound.audioLevel !== undefined ? (inbound.audioLevel*100).toFixed(1) : 'N/A';
        const availableOutBitrate = pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate/1000) : 'N/A';
        const connState = pc.connectionState || 'N/A';
        const iceState = pc.iceConnectionState || 'N/A';
        
        // Summarize on first line
        const el = document.createElement('div');
        el.style.padding = '8px';
        el.style.marginBottom = '8px';
        el.style.borderLeft = '3px solid #4f46e5';
        el.style.background = '#f9fafb';
        el.style.borderRadius = '4px';
        
        // Add track count information
        const senderCount = pc._senders ? Object.keys(pc._senders).filter(k => pc._senders[k]).length : 0;
        const inboundCount = inbounds.length;
        const outboundCount = outbounds.length;
        
        const firstLine = `<strong>peer ${id}</strong> | 连接: ${connState} | ICE: ${iceState} | 📡 发送${senderCount}轨 | 📨 收${inboundCount}轨 | 📤 送${outboundCount}轨`;
        const secondLine = `📊 Loss: ${loss.toFixed(2)}% | RTT: ${rtt}ms | 抖动: ${jitter}ms`;
        
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
  const captureStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    }
  });
  const audioTrack = getAudioTrack(captureStream);

  if (!audioTrack) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error('未获取到系统声音，请在共享窗口时勾选“共享音频”。');
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
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          console.log(`[${data.from}] Applied answer`);
        } catch (e) {
          console.error(`[${data.from}] Error setting remote answer:`, e);
        }
      }
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
  pc._negotiationInProgress = false;
  attachCurrentSources(pc);
  // if system audio is already enabled, add system sender immediately
  if (systemEnabled) {
    addSystemAudioSender(pc);
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

    // Only iOS Safari blocks <audio> autoplay for WebRTC streams.
    // All other browsers (Android Chrome, Edge, desktop Chrome, etc.) handle it fine.
    // Web Audio API is only used for iOS Safari because it bypasses the autoplay block.
    // NOTE: On iOS Safari, Web Audio routes WebRTC to the earpiece; headphones needed.
    const isIOSSafari = /Safari/i.test(navigator.userAgent) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/i.test(navigator.userAgent) &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
       (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

    if (isIOSSafari) {
      // iOS Safari: use Web Audio API (only path that works without user gesture)
      try {
        if (remoteAudioSources[peerId]) {
          remoteAudioSources[peerId].disconnect();
        }
        if (audioContext && audioContext.state !== 'running') {
          await audioContext.resume().catch(() => {});
        }
        if (audioContext && audioContext.state === 'running') {
          const source = audioContext.createMediaStreamSource(stream);
          source.connect(audioContext.destination);
          remoteAudioSources[peerId] = source;
          console.log(`[${peerId}] iOS Safari: playing via Web Audio API`);
        }
      } catch (err) {
        console.warn(`[${peerId}] Web Audio playback failed`, err);
      }
    } else {
      // All other browsers: use <audio> element (works reliably everywhere)
      let audio = document.getElementById('audio-' + peerId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'audio-' + peerId;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute('playsinline', '');
        remotes.appendChild(audio);
      }
      audio.srcObject = stream;
      audio.play().catch(() => {});

      // Clean up any stale Web Audio source (avoid double playback)
      if (remoteAudioSources[peerId]) {
        try { remoteAudioSources[peerId].disconnect(); } catch(e) {}
        delete remoteAudioSources[peerId];
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
    console.log(`[handleOffer] Sent answer to ${from}`);
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
