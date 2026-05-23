import { dom, S, servers } from './state.js';
import { createOffer, handleOffer, closePeer, resetPeerConnections } from './peer.js';
import { fetchRooms } from './room-ui.js';
import { launchFireworks, showReaction, updateStatus, ensureListenerGain } from './ui.js';
import { ensureAudioPipeline, startInputMeter } from './audio.js';
import { startStatsPolling } from './stats.js';

export function connectWs() {
  const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
  console.log('connectWs URL:', url, 'location.host:', location.host, 'location.protocol:', location.protocol);
  S.ws = new WebSocket(url);
  console.log('WebSocket created, readyState:', S.ws.readyState);

  S.ws.onopen = () => {
    S.wsReconnectAttempts = 0;
    if (S.wsReconnectTimer) {
      clearTimeout(S.wsReconnectTimer);
      S.wsReconnectTimer = null;
    }
    if (S.joined) {
      resetPeerConnections();
    }
    S.ws.send(JSON.stringify({ type: 'join', room: dom.roomInput.value, role: S.myRole }));
  };

  S.ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);

    if (data.type === 'joined') {
      S.myId = data.id;
      S.joined = true;

      document.getElementById('room-list').classList.add('disabled');
      try { localStorage.setItem('p2p_room', dom.roomInput.value); } catch (_) {}
      try { localStorage.setItem('p2p_role', S.myRole); } catch (_) {}
      try { history.replaceState(null, '', '#' + dom.roomInput.value); } catch (_) {}

      if (data.roles) S.peerRoles = { ...data.roles };

      if (data.reactionCounts) {
        Object.assign(S.reactionCounts, data.reactionCounts);
        for (const [emoji, count] of Object.entries(data.reactionCounts)) {
          const btn = document.querySelector(`#reaction-bar button[data-emoji="${emoji}"]`);
          if (btn) btn.querySelector('.rc').textContent = count;
        }
      }

      if (data.yourRole) {
        if (S.myRole === 'host' && data.yourRole === 'listener') {
          dom.statusEl.textContent = '该电台已有主播，已自动切换为听众模式。';
        }
        S.myRole = data.yourRole;
      }

      if (S.myRole === 'host') {
        document.getElementById('host-controls').style.display = 'inline';
        document.getElementById('host-meters').style.display = 'block';
        document.getElementById('listener-meters').style.display = 'none';
        try {
          await ensureAudioPipeline();
          startInputMeter();
        } catch (error) {
          console.error(error);
          dom.statusEl.textContent = '音频初始化失败：' + error.message;
        }
        dom.toggleMicBtn.disabled = false;
        dom.toggleSystemBtn.disabled = false;
      } else {
        document.getElementById('host-controls').style.display = 'none';
        document.getElementById('host-meters').style.display = 'none';
        document.getElementById('listener-meters').style.display = 'block';
        if (!S.listenerAudioContext || S.listenerAudioContext.state === 'closed') {
          S.listenerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
          console.log(`[listener] created new AudioContext (state=${S.listenerAudioContext.state})`);
        }
        console.log(`[listener] AudioContext state before resume: ${S.listenerAudioContext.state}`);
        S.listenerAudioContext.resume().then(() => {
          console.log(`[listener] AudioContext resumed successfully, state=${S.listenerAudioContext.state}`);
        }).catch((err) => {
          console.warn(`[listener] AudioContext resume failed:`, err);
          dom.statusEl.textContent = `⚠️ 音频初始化被浏览器阻止，请点击页面任意位置后再试`;
        });
      }

      updateStatus();

      dom.createBtn.classList.add('hidden');
      dom.joinBtn.classList.add('hidden');
      dom.roomInput.disabled = true;
      const leaveBtn = document.getElementById('leave');
      if (leaveBtn) leaveBtn.classList.remove('hidden');

      document.getElementById('reaction-bar').style.display = 'flex';
      const fwBtn = document.getElementById('firework-btn');
      if (fwBtn) fwBtn.classList.toggle('hidden', S.myRole !== 'host');
      const muteBtn = document.getElementById('mute-btn');
      if (muteBtn) {
        muteBtn.classList.remove('hidden');
        muteBtn.textContent = '🔊 收听中';
        muteBtn.classList.remove('muted');
      }

      fetchRooms();
      startStatsPolling();

      const peers = data.peers;
      for (const peerId of peers) {
        await createOffer(peerId);
      }

    } else if (data.type === 'peer-joined') {
      if (data.role) S.peerRoles[data.id] = data.role;
      return;

    } else if (data.type === 'offer') {
      await handleOffer(data.from, data.sdp);

    } else if (data.type === 'answer') {
      const pc = S.pcMap[data.from];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } catch (e) {
          console.error(`[${data.from}] Error setting remote answer:`, e);
        }
      }

    } else if (data.type === 'ice') {
      const pc = S.pcMap[data.from];
      if (pc && data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e) {}
      }

    } else if (data.type === 'firework') {
      dom.statusEl.textContent = '🎆 主播放了一个烟花！';
      try { launchFireworks(); } catch (e) { console.error('firework:', e); }
      setTimeout(() => updateStatus(), 3000);

    } else if (data.type === 'reaction') {
      if (data.count !== undefined) S.reactionCounts[data.emoji] = data.count;
      const btn = document.querySelector(`#reaction-bar button[data-emoji="${data.emoji}"]`);
      if (btn) btn.querySelector('.rc').textContent = S.reactionCounts[data.emoji];
      showReaction(data.emoji);

    } else if (data.type === 'peer-left') {
      delete S.peerRoles[data.id];
      closePeer(data.id);
    }
  };

  S.ws.onclose = (ev) => {
    console.warn('WebSocket closed', { code: ev?.code, reason: ev?.reason, wasClean: ev?.wasClean, joined: S.joined });
    if (!S.joined) return;
    scheduleWsReconnect();
  };

  S.ws.onerror = (ev) => {
    console.error('WebSocket error', ev);
  };
}

export function scheduleWsReconnect() {
  if (S.wsReconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, S.wsReconnectAttempts), 30000);
  S.wsReconnectAttempts++;
  dom.statusEl.textContent = `WebSocket 断开，${(delay / 1000).toFixed(0)}s 后重连…（第 ${S.wsReconnectAttempts} 次）`;
  S.wsReconnectTimer = setTimeout(() => {
    S.wsReconnectTimer = null;
    connectWs();
  }, delay);
}
