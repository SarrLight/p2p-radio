import { dom, S, servers } from './state.js';

// ── Fireworks ───────────────────────────────────────────────────────────
export function launchFireworks() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const particles = [];
  const sparkles = [];
  const rockets = [];
  const glows = [];
  const colors = ['#f87171','#fb923c','#fbbf24','#4ade80','#60a5fa','#c084fc','#f472b6','#f9a8d4'];
  const goldPalette = ['#fff7cc','#ffe066','#ffd43b','#fab005'];

  const rocketCount = 5 + Math.floor(Math.random() * 4);
  const now0 = performance.now();

  for (let i = 0; i < rocketCount; i++) {
    const launchDelay = Math.random() * 0.6;
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
        r.wobblePhase += dt * 8;
        const wobbleX = Math.sin(r.wobblePhase) * 1.5;
        r.y -= r.speed * dt;
        r.x += wobbleX * dt * 60;

        r.trail.push({ x: r.x, y: r.y, life: 1, bright: Math.random() > 0.3 });
        if (r.trail.length > 20) r.trail.shift();

        for (let i = 0; i < r.trail.length; i++) {
          const t = r.trail[i];
          t.life -= 2.5 * dt;
          if (t.life <= 0) continue;
          const alpha = t.life * (t.bright ? 0.7 : 0.25);
          const size = t.bright ? 2.2 : 1.2;
          ctx.globalAlpha = Math.max(0, alpha);
          ctx.fillStyle = t.bright ? goldPalette[i % 4] : '#fab005';
          ctx.beginPath();
          ctx.arc(t.x, t.y, size, 0, Math.PI * 2);
          ctx.fill();
        }

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
          glows.push({ x: r.x, y: r.y, life: 0.4, color: r.color });
          for (let j = 0; j < 60; j++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 60 + Math.random() * 580;
            particles.push({ x: r.x, y: r.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, decay: 0.3 + Math.random() * 1.6, color: r.color, size: 0.8 + Math.random() * 2.2 });
          }
          for (let j = 0; j < 50; j++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 80 + Math.random() * 350;
            sparkles.push({ x: r.x, y: r.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0.2 + Math.random() * 0.8, decay: 0.8 + Math.random() * 2.5, size: 0.8 + Math.random() * 1.5 });
          }
        }
      }
    }

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

    for (const s of sparkles) {
      if (s.life <= 0) continue;
      alive = true;
      s.vy += 300 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= s.decay * dt;
      if (s.life <= 0) continue;
      const rnd = Math.random();
      if (rnd > 0.55) {
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
    }

    if (alive) {
      raf = requestAnimationFrame(tick);
    } else {
      canvas.remove();
    }
  };
  raf = requestAnimationFrame(tick);
}

// ── Reaction UI ─────────────────────────────────────────────────────────
export function showReaction(emoji) {
  if (document.hidden) return;
  const el = document.createElement('span');
  el.className = 'reaction-float';
  el.textContent = emoji;
  el.style.left = `${40 + Math.random() * 30}%`;
  el.style.bottom = '30%';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ── Status ──────────────────────────────────────────────────────────────
export function updateStatus() {
  if (!S.joined) {
    dom.statusEl.textContent = '请选择角色后加入电台。';
    return;
  }
  if (S.myRole === 'host') {
    dom.toggleMicBtn.textContent = S.micEnabled ? '麦克风：开' : '麦克风：关';
    dom.toggleSystemBtn.textContent = S.systemEnabled ? '系统声音：开' : '系统声音：关';
    dom.statusEl.textContent = `麦克风：${S.micEnabled ? '开' : '关'}，系统声音：${S.systemEnabled ? '开（画面已丢弃）' : '关'}。`;
  } else {
    dom.statusEl.textContent = '听众模式，正在收听广播。';
  }
}

// ── Playback meter ──────────────────────────────────────────────────────
export function setPlaybackMeter(levelPercent, dbfs, isActive) {
  if (dom.playbackMeterFillEl) {
    dom.playbackMeterFillEl.style.width = `${levelPercent}%`;
  }
  if (dom.playbackMeterTextEl) {
    if (dbfs <= -120) {
      dom.playbackMeterTextEl.innerHTML = '&minus;&infin; <small>dBFS</small>';
    } else {
      dom.playbackMeterTextEl.innerHTML = `${dbfs.toFixed(1)} <small>dBFS</small>`;
    }
  }
  if (dom.playbackMeterStateEl) {
    dom.playbackMeterStateEl.textContent = isActive ? '正在播放' : '';
    dom.playbackMeterStateEl.className = 'meter-state' + (isActive ? ' live' : '');
  }
}

// ── Access URL (local STUN discovery) ───────────────────────────────────
export function updateAccessUrl() {
  if (!dom.accessUrlEl) return;

  dom.accessUrlEl.textContent = `当前访问地址：读取中...`;

  fetch('/api/access-url')
    .then((response) => response.json())
    .then((data) => {
      if (data && data.url) {
        const interfaceText = data.preferredInterface ? `（网卡：${data.preferredInterface}）` : '';
        dom.accessUrlEl.textContent = `手机访问地址（推荐）：${data.url}${interfaceText}`;
      } else {
        dom.accessUrlEl.textContent = `当前访问地址：${location.origin}`;
      }
      if (data && data.preferredAddress) {
        servers.iceServers[0].urls = `stun:${data.preferredAddress}:3478`;
      }
    })
    .catch(() => {
      dom.accessUrlEl.textContent = `当前访问地址：${location.origin}`;
    });
}

// ── Listener gain ───────────────────────────────────────────────────────
export function ensureListenerGain() {
  if (!S.listenerGainNode && S.listenerAudioContext) {
    S.listenerGainNode = S.listenerAudioContext.createGain();
    S.listenerGainNode.gain.value = S.listenerMuted ? 0 : 1;
    S.listenerGainNode.connect(S.listenerAudioContext.destination);
  }
}
