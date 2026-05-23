import { dom, S, servers } from './state.js';
import { mungeOpusSdp } from './sdp.js';
import { attachCurrentSources, addSystemAudioSender, registerPlaybackStream, unregisterPlaybackStream } from './audio.js';
import { setPlaybackMeter, ensureListenerGain } from './ui.js';

export function makePC(peerId) {
  const pc = new RTCPeerConnection(servers);
  pc._negotiationInProgress = false;

  if (S.myRole === 'host') {
    attachCurrentSources(pc);
    if (S.systemEnabled) addSystemAudioSender(pc);
  }

  // Receive-only transceiver for Safari compat
  const hasAudioSender = pc.getSenders().some(s => s.track && s.track.kind === 'audio');
  if (!hasAudioSender) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const cand = e.candidate;
      const candType = cand.type || 'unknown';
      const proto = cand.protocol || '?';
      const addr = cand.address || cand.ip || '?';
      const port = cand.port || '?';
      console.log(`[${peerId}] ICE candidate: ${candType} ${proto} ${addr}:${port} (sdpMid=${cand.sdpMid})`);
      S.ws.send(JSON.stringify({ type: 'ice', to: peerId, candidate: e.candidate }));
    } else {
      console.log(`[${peerId}] ICE candidate gathering complete`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[${peerId}] ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.log(`[${peerId}] ICE failed, attempting restart`);
      dom.statusEl.textContent = `⚠️ 与主播 ${peerId} 的 ICE 连接失败，正在重试…`;
      restartIce(pc, peerId);
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    console.log(`[${peerId}] connection state: ${st}`);
    if (st === 'connected') {
      // 8s watchdog: if still no audio, log a hint (no statusEl update —
      // diagnostics panel reflects it). Audio usually arrives shortly after.
      setTimeout(() => {
        if (!S.joined) return;
        pc.getStats().then(stats => {
          let hasAudio = false;
          stats.forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio' && (r.bytesReceived || 0) > 0) hasAudio = true;
          });
          if (!hasAudio) {
            console.info(`[${peerId}] connected 8s, no audio yet (normal if host hasn't enabled mic/system audio)`);
          }
        }).catch(() => {});
      }, 8000);
    } else if (st === 'failed') {
      dom.statusEl.textContent = `❌ 与主播 ${peerId} 的连接已断开`;
    } else if (st === 'disconnected') {
      console.warn(`[${peerId}] connection disconnected`);
    }
  };

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
      if (S.ws && S.ws.readyState === WebSocket.OPEN) {
        console.log(`[${peerId}] Sending renegotiation offer`);
        S.ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
      }
    } catch (e) {
      console.error(`[${peerId}] negotiation error:`, e);
    } finally {
      pc._negotiationInProgress = false;
    }
  };

  pc.ontrack = async (e) => {
    const stream = e.streams[0];
    const audioTracks = stream.getAudioTracks();
    console.log(`[${peerId}] ontrack fired, stream has ${audioTracks.length} audio tracks`);
    audioTracks.forEach((t, i) => {
      console.log(`[${peerId}] audio track[${i}]: id=${t.id}, kind=${t.kind}, enabled=${t.enabled}, muted=${t.muted}, readyState=${t.readyState}`);
    });
    if (audioTracks.length === 0) {
      console.warn(`[${peerId}] ⚠️ ontrack fired but NO audio tracks in stream!`);
    }
    if (e.receiver && e.receiver.playoutDelayHint !== undefined) {
      try {
        e.receiver.playoutDelayHint = { min: 0.15, max: 0.5 };
        console.log(`[${peerId}] playoutDelayHint set to {min:150ms, max:500ms}`);
      } catch (_) {}
    }

    // ── Playback path selection ──────────────────────────────────────
    // iOS: <audio playsinline autoplay> works after page interaction.
    // Do NOT call .play() — outside user gesture it rejects and may
    // interfere with autoplay.  No Web Audio fallback (iOS silently
    // blocks MediaStreamSource→destination outside gesture).
    // Level meter runs independently on listenerAudioContext.
    const isIOS = /iPad|iPhone|iPod|EdgiOS|FxiOS|CriOS/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS) {
      let audio = document.getElementById('audio-' + peerId);
      if (audio) audio.remove();
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.playsInline = true;
      audio.setAttribute('playsinline', '');
      dom.remotes.appendChild(audio);
      audio.srcObject = stream;
      // Fire-and-forget play() as a hint; don't await — rejection is harmless
      audio.play().catch(() => {});
      console.log(`[${peerId}] iOS: <audio> playback (autoplay+playsinline)`);
    } else {
      let audio = document.getElementById('audio-' + peerId);
      if (audio) audio.remove();
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.playsInline = true;
      audio.setAttribute('playsinline', '');
      dom.remotes.appendChild(audio);
      audio.srcObject = stream;

      const played = await audio.play().then(() => true).catch(() => false);
      if (!played) {
        console.log(`[${peerId}] audio.play() blocked, switching to Web Audio`);
        audio.remove();
        try {
          if (S.remoteAudioSources[peerId]) S.remoteAudioSources[peerId].disconnect();
          if (!S.listenerAudioContext || S.listenerAudioContext.state === 'closed') {
            S.listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          if (S.listenerAudioContext.state !== 'running') {
            S.listenerAudioContext.resume().catch(() => {});
          }
          {
            const source = S.listenerAudioContext.createMediaStreamSource(stream);
            ensureListenerGain();
            source.connect(S.listenerGainNode || S.listenerAudioContext.destination);
            S.remoteAudioSources[peerId] = source;
            console.log(`[${peerId}] playing via Web Audio fallback`);
          }
        } catch (err) {
          console.warn(`[${peerId}] Web Audio fallback failed`, err);
        }
      } else {
        if (S.remoteAudioSources[peerId]) {
          try { S.remoteAudioSources[peerId].disconnect(); } catch(e) {}
          delete S.remoteAudioSources[peerId];
        }
      }
    }

    registerPlaybackStream(peerId, stream).catch((error) => {
      console.error('Failed to register playback stream', error);
    });
  };

  S.pcMap[peerId] = pc;
  window.__pcMap = S.pcMap;
  return pc;
}

export async function createOffer(peerId) {
  let pc = S.pcMap[peerId];
  if (!pc) {
    pc = makePC(peerId);
  }
  try {
    pc._negotiationInProgress = true;
    const offer = await pc.createOffer();
    offer.sdp = mungeOpusSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    S.ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
    console.log(`[createOffer] Sent initial offer to ${peerId}`);
  } catch (e) {
    console.error(`[createOffer] Error creating offer for ${peerId}:`, e);
  } finally {
    pc._negotiationInProgress = false;
  }
}

export async function handleOffer(from, sdp) {
  let pc = S.pcMap[from];
  if (!pc) {
    pc = makePC(from);
  }
  try {
    pc._negotiationInProgress = true;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    answer.sdp = mungeOpusSdp(answer.sdp);
    await pc.setLocalDescription(answer);
    S.ws.send(JSON.stringify({ type: 'answer', to: from, sdp: pc.localDescription }));
  } catch (e) {
    console.error(`[handleOffer] Error handling offer from ${from}:`, e);
  } finally {
    pc._negotiationInProgress = false;
  }
}

export function closePeer(id) {
  const pc = S.pcMap[id];
  if (pc) {
    pc.close();
    delete S.pcMap[id];
    window.__pcMap = S.pcMap;
  }
  if (S.remoteAudioSources[id]) {
    try { S.remoteAudioSources[id].disconnect(); } catch(e) {}
    delete S.remoteAudioSources[id];
  }
  unregisterPlaybackStream(id);
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.remove();
}

export function resetPeerConnections() {
  for (const [id, pc] of Object.entries(S.pcMap)) {
    pc.close();
  }
  S.pcMap = {};
  window.__pcMap = S.pcMap;
  for (const id of Object.keys(S.remoteAudioSources)) {
    try { S.remoteAudioSources[id].disconnect(); } catch(e) {}
    delete S.remoteAudioSources[id];
  }
  document.querySelectorAll('#remotes audio').forEach(el => el.remove());
  for (const [id, source] of S.playbackStreamSources) {
    try { source.disconnect(); } catch(e) {}
  }
  S.playbackStreamSources.clear();
  setPlaybackMeter(0, -120, false);
  S.peerRoles = {};
}

async function restartIce(pc, peerId) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  try {
    pc._negotiationInProgress = true;
    const offer = await pc.createOffer({ iceRestart: true });
    offer.sdp = mungeOpusSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    S.ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
    console.log(`[${peerId}] ICE restart offer sent`);
  } catch (e) {
    console.error(`[${peerId}] ICE restart failed:`, e);
  } finally {
    pc._negotiationInProgress = false;
  }
}

