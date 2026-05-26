// ── Real-time chat module ──
// Requires: state.js (for S, dom)
// Renders a chat panel inside the chat card.
// Messages: server broadcasts { type: 'chat', id, senderId, senderLabel, text, time }
// History: server sends { type: 'chat-history', messages: [...] }

import { dom, S } from './state.js';

const MAX_VISIBLE = 200; // max messages in the DOM at once

// DOM refs — populated on first render
let chatContainer = null;
let chatMessages = null;
let chatInput = null;
let chatSendBtn = null;
let isAtBottom = true;

// Internal message buffer (all messages received)
const messages = [];

export function initChat() {
  chatContainer = document.getElementById('chat-messages');
  chatMessages = document.getElementById('chat-msg-list');
  chatInput = document.getElementById('chat-input');
  chatSendBtn = document.getElementById('chat-send-btn');

  if (!chatContainer || !chatInput || !chatSendBtn) {
    console.warn('Chat DOM elements not found');
    return;
  }

  // Send on button click
  chatSendBtn.addEventListener('click', sendChat);

  // Send on Enter key
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  // Detect scroll position
  chatContainer.addEventListener('scroll', () => {
    const el = chatContainer;
    isAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 30;
  });

  // Wait for input to be re-enabled on show
  chatInput.addEventListener('focus', () => {
    // Auto-scroll to bottom when user starts typing
    scrollToBottom();
  });
}

function sendChat() {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    addSystemMessage('连接已断开，无法发送');
    return;
  }
  S.ws.send(JSON.stringify({ type: 'chat', text }));
  chatInput.value = '';
  chatInput.focus();
}

export function handleChatMessage(msg) {
  // msg: { id, senderId, senderLabel, text, time }
  messages.push(msg);
  if (messages.length > MAX_VISIBLE) {
    const removed = messages.splice(0, messages.length - MAX_VISIBLE);
    // Also trim DOM child nodes
    if (chatMessages && removed.length > 0) {
      const children = chatMessages.children;
      for (let i = 0; i < removed.length && i < children.length; i++) {
        if (children[0]) chatMessages.removeChild(children[0]);
      }
    }
  }
  renderMessage(msg);
  if (isAtBottom) scrollToBottom();
}

export function handleChatHistory(history) {
  // history: array of messages, oldest first
  if (!history || history.length === 0) return;
  messages.length = 0;
  // Clear existing DOM messages
  if (chatMessages) chatMessages.innerHTML = '';
  for (const msg of history) {
    messages.push(msg);
    renderMessage(msg);
  }
  scrollToBottom();
}

function renderMessage(msg) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.dataset.msgId = msg.id;

  // Determine if this is the current user's message
  // Use CC98 sub for persistent identity across reconnects
  const isMine = (msg.userSub && S.myUserSub && msg.userSub === S.myUserSub) || msg.senderId === S.myId;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble' + (isMine ? ' mine' : '');

  // Header: sender label + time
  const header = document.createElement('div');
  header.className = 'chat-header';
  header.textContent = `${msg.senderLabel}  ${msg.time}`;
  bubble.appendChild(header);

  // Text
  const body = document.createElement('div');
  body.className = 'chat-body';
  body.textContent = msg.text;
  bubble.appendChild(body);

  div.appendChild(bubble);
  chatMessages.appendChild(div);
}

function addSystemMessage(text) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  const el = document.createElement('div');
  el.className = 'chat-system';
  el.textContent = text;
  div.appendChild(el);
  chatMessages.appendChild(div);
  if (isAtBottom) scrollToBottom();
}

function scrollToBottom() {
  if (chatContainer) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
    isAtBottom = true;
  }
}

// Export for visibility toggling
export function showChat() {
  const card = document.getElementById('chat-card');
  if (card) card.style.display = 'block';
  setTimeout(() => {
    if (chatInput) {
      chatInput.disabled = false;
      chatInput.focus();
    }
    scrollToBottom();
  }, 100);
}

export function hideChat() {
  const card = document.getElementById('chat-card');
  if (card) card.style.display = 'none';
  if (chatMessages) chatMessages.innerHTML = '';
  messages.length = 0;
  if (chatInput) chatInput.value = '';
}
