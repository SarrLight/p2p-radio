(async function(){
const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('join');
const toggleMicBtn = document.getElementById('toggle-mic');
const toggleSystemBtn = document.getElementById('toggle-system');
const statusEl = document.getElementById('status');
const localContainer = document.getElementById('local');
const remotes = document.getElementById('remotes');

let pcMap = {};
let ws;
let micStream = null;
let systemStream = null;
let micEnabled = false;
let systemEnabled = false;
let localPreviewAudio = null;
let myId;

const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function ensureLocalPreview() {
  if (!localPreviewAudio) {
    localPreviewAudio = document.createElement('audio');
    localPreviewAudio.autoplay = true;
    localPreviewAudio.muted = true;
    localContainer.appendChild(localPreviewAudio);
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

function syncSourceToPeers(kind, stream) {
  const track = getAudioTrack(stream);

  for (const pc of Object.values(pcMap)) {
    pc._senders = pc._senders || {};
    const sender = pc._senders[kind];

    if (sender) {
      sender.replaceTrack(track);
    } else if (track) {
      pc._senders[kind] = pc.addTrack(track, stream);
    }
  }
}

function attachCurrentSources(pc) {
  pc._senders = {};

  if (micStream) {
    const micTrack = getAudioTrack(micStream);
    if (micTrack) {
      pc._senders.mic = pc.addTrack(micTrack, micStream);
    }
  }

  if (systemStream) {
    const systemTrack = getAudioTrack(systemStream);
    if (systemTrack) {
      pc._senders.system = pc.addTrack(systemTrack, systemStream);
    }
  }
}

async function enableMic() {
  if (micEnabled) {
    return;
  }

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micEnabled = true;
  syncSourceToPeers('mic', micStream);
  refreshLocalPreview();
  updateStatus();
}

function disableMic() {
  if (!micEnabled) {
    return;
  }

  micEnabled = false;
  syncSourceToPeers('mic', null);
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

  const captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTrack = getAudioTrack(captureStream);

  if (!audioTrack) {
    captureStream.getTracks().forEach((track) => track.stop());
    throw new Error('未获取到系统声音，请在共享窗口时勾选“共享音频”。');
  }

  systemStream = captureStream;
  systemEnabled = true;
  captureStream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (systemEnabled) {
        disableSystemAudio();
      }
    }, { once: true });
  });
  syncSourceToPeers('system', systemStream);
  refreshLocalPreview();
  updateStatus();
}

function disableSystemAudio() {
  if (!systemEnabled) {
    return;
  }

  systemEnabled = false;
  syncSourceToPeers('system', null);
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
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.remove();
}

joinBtn.onclick = async () => {
  await enableMic();
  connectWs();
  joinBtn.disabled = true;
  toggleMicBtn.disabled = false;
  toggleSystemBtn.disabled = false;
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
updateStatus();

})();
