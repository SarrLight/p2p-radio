import { dom, S } from './state.js';
import { updateStatus } from './ui.js';

// ── Room discovery ──────────────────────────────────────────────────────
let roomPollInterval = null;
let roomData = {}; // roomName -> { hasHost: bool }

export async function fetchRooms() {
  const listEl = document.getElementById('room-list');
  if (!listEl) return;
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    const rooms = data.rooms || {};

    roomData = {};
    for (const [name, info] of Object.entries(rooms)) {
      roomData[name] = { hasHost: (info.clients || []).some(c => c.role === 'host') };
    }

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
        if (S.joined) return;
        dom.roomInput.value = name;
        updateRoleSelectorForRoom(name);
      });
      listEl.appendChild(item);
    }
  } catch (_) {}
  if (!S.joined) updateRoleSelectorForRoom(dom.roomInput.value.trim());
}

export function updateRoleSelectorForRoom(roomName) {
  const info = roomData[roomName];
  const hostBtn = document.getElementById('role-host');
  const listenerBtn = document.getElementById('role-listener');
  if (!hostBtn || !listenerBtn) return;

  if (info && info.hasHost && S.myRole !== 'host') {
    hostBtn.disabled = true;
    hostBtn.classList.add('locked');
    listenerBtn.classList.add('active');
    hostBtn.classList.remove('active');
    S.myRole = 'listener';
  } else if (!info || !info.hasHost) {
    hostBtn.disabled = false;
    hostBtn.classList.remove('locked');
  }
}

export function startRoomPolling(intervalMs = 5000) {
  if (roomPollInterval) return;
  fetchRooms();
  roomPollInterval = setInterval(fetchRooms, intervalMs);
}

export function stopRoomPolling() {
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
