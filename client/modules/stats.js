import { dom, S } from './state.js';
import { setPlaybackMeter } from './ui.js';

// store last bytes/timestamp per peer to compute bitrate delta for in/out
const _lastStats = {};
let statsIntervalId = null;

export function startStatsPolling(intervalMs = 5000) {
  if (statsIntervalId) return;
  statsIntervalId = setInterval(async () => {
    const container = document.getElementById('stats-container');
    if (!container) return;
    container.innerHTML = '';

    const myRoleLabel = S.myRole === 'host' ? '🎤主播' : '🎧听众';
    const meEl = document.createElement('div');
    meEl.style.cssText = 'padding:4px 8px;margin-bottom:8px;font-size:12px;color:var(--text-muted)';
    meEl.textContent = `我的 ID: ${S.myId || '—'}  ${myRoleLabel}`;
    container.appendChild(meEl);

    const keys = Object.keys(S.pcMap);
    if (keys.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.textContent = '无连接';
      emptyEl.style.cssText = 'font-size:13px;color:var(--text-muted)';
      container.appendChild(emptyEl);
      return;
    }

    const allRaw = {};
    for (const [id, pc] of Object.entries(S.pcMap)) {
      try {
        const stats = await pc.getStats();
        const reports = {};
        stats.forEach(r => { reports[r.id || (r.type+'-'+Math.random().toString(36).slice(2,6))] = r; });
        allRaw[id] = reports;

        const inbounds = [];
        const outbounds = [];
        let pair = null;
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') inbounds.push(r);
          if (r.type === 'outbound-rtp' && r.kind === 'audio') outbounds.push(r);
          if (r.type === 'candidate-pair' && r.nominated) pair = r;
        });

        const inbound = inbounds.length > 0 ? inbounds[0] : null;
        const outbound = outbounds.length > 0 ? outbounds[0] : null;

        const loss = inbound ? ((inbound.packetsLost||0) / Math.max(1, inbound.packetsReceived||0))*100 : 0;
        const rtt = pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime*1000) : 0;

        // Audio silence detection — recorded in _silentPolls but no
        // statusEl update (diagnostics panel shows the connection info)
        const silentBytes = inbounds.reduce((s, ib) => s + (ib.bytesReceived || 0), 0);
        if (!pc._silentPolls) pc._silentPolls = 0;
        if (silentBytes === 0 && S.myRole === 'listener' && pc.connectionState === 'connected') {
          pc._silentPolls++;
        } else if (silentBytes > 0) {
          pc._silentPolls = 0;
        }

        // Bitrate calculation
        const last = _lastStats[id] || { inTracks: {}, outTracks: {} };
        let totalInBitrate = 0;
        let totalOutBitrate = 0;
        const inBitrates = {};
        const outBitrates = {};

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

        const outCodec = outbound && outbound.mimeType ? outbound.mimeType.split('/').pop() : 'unknown';
        const inCodec = inbound && inbound.mimeType ? inbound.mimeType.split('/').pop() : 'unknown';
        const jitter = inbound && inbound.jitter ? (inbound.jitter*1000).toFixed(2) : 'N/A';
        const jbDelay = inbound && inbound.jitterBufferEmittedCount
          ? ((inbound.jitterBufferDelay || 0) / inbound.jitterBufferEmittedCount * 1000).toFixed(0)
          : 'N/A';
        const audioLevel = inbound && inbound.audioLevel !== undefined ? (inbound.audioLevel*100).toFixed(1) : 'N/A';
        const availableOutBitrate = pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate/1000) : 'N/A';
        const connState = pc.connectionState || 'N/A';
        const iceState = pc.iceConnectionState || 'N/A';

        const el = document.createElement('div');
        el.style.cssText = 'padding:8px;margin-bottom:6px;border-left:3px solid #4ade80;background:rgba(255,255,255,.03);border-radius:6px';

        const senderCount = pc._senders ? Object.keys(pc._senders).filter(k => pc._senders[k]).length : 0;
        const inboundCount = inbounds.length;
        const outboundCount = outbounds.length;

        const peerRole = S.peerRoles[id] || 'unknown';
        const roleBadge = peerRole === 'host' ? '🎤主播' : '🎧听众';
        const firstLine = `<strong>peer ${id}</strong> (${roleBadge}) | 连接: ${connState} | ICE: ${iceState} | 📡 发送${senderCount}轨 | 📨 收${inboundCount}轨 | 📤 送${outboundCount}轨`;
        const secondLine = `📊 Loss: ${loss.toFixed(2)}% | RTT: ${rtt}ms | 抖动: ${jitter}ms | 缓冲: ${jbDelay}ms`;

        const outBitsList = Object.keys(outBitrates).map(k => outBitrates[k]).join(',');
        const inBitsList = Object.keys(inBitrates).map(k => inBitrates[k]).join(',');
        const thirdLine = outbounds.length > 1 || inbounds.length > 1
          ? `📤 Out: [${outBitsList}] kbps | 📥 In: [${inBitsList}] kbps`
          : `📤 Out: ${totalOutBitrate}kbps (${outCodec}) | 📥 In: ${totalInBitrate}kbps (${inCodec})`;
        const fourthLine = `🔊 Level: ${audioLevel}% | 可用: ${availableOutBitrate} kbps`;

        let totalInBytes = 0, totalInPackets = 0, totalOutBytes = 0, totalOutPackets = 0;
        inbounds.forEach(ib => { if (ib.bytesReceived) totalInBytes += ib.bytesReceived; if (ib.packetsReceived) totalInPackets += ib.packetsReceived; });
        outbounds.forEach(ob => { if (ob.bytesSent) totalOutBytes += ob.bytesSent; if (ob.packetsSent) totalOutPackets += ob.packetsSent; });
        const fifthLine = `📨 收: ${(totalInBytes/1024).toFixed(1)}KB (${totalInPackets}包) | 📬 发: ${(totalOutBytes/1024).toFixed(1)}KB (${totalOutPackets}包)`;

        el.innerHTML = `${firstLine}<br/>${secondLine}<br/>${thirdLine}<br/>${fourthLine}<br/>${fifthLine}`;
        container.appendChild(el);
      } catch (e) {
        const el = document.createElement('div');
        el.style.color = '#f87171';
        const msg = e && e.message ? e.message : String(e);
        el.textContent = `peer ${id}: stats error: ${msg}`;
        container.appendChild(el);
        if (dom.statsRawEl) {
          dom.statsRawEl.textContent = `stats error for peer ${id}: ${e && e.stack ? e.stack : msg}`;
        }
        console.error('stats error for peer', id, e);
      }
    }
    if (dom.statsRawEl) dom.statsRawEl.textContent = JSON.stringify(allRaw, null, 2);
  }, intervalMs);
}

export function stopStatsPolling() {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
}
