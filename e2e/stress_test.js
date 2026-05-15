// Stress test: spawn N listeners and measure how many the host can serve.
//   node e2e/stress_test.js [count] [room]
//
// Prerequisites:
//   1. Start the server:  cd server && npm start
//   2. Open a browser tab as HOST (主播), join the room, enable system audio.
//   3. Run this script:   node e2e/stress_test.js 20 test
//
// The script opens N headless Chromium tabs, each joining as a listener.
// It reports how many successfully connected and received audio.

const { chromium } = require('playwright');

const LISTENER_COUNT = parseInt(process.argv[2]) || 10;
const ROOM = process.argv[3] || 'test';
const URL = process.env.URL || 'https://localhost:3000';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log(`启动 ${LISTENER_COUNT} 个听众，房间: ${ROOM}`);
  console.log(`服务器: ${URL}`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (let i = 0; i < LISTENER_COUNT; i++) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const listenerId = i + 1;

    try {
      // Navigate and wait for page to load
      await page.goto(URL, { timeout: 10000 });

      // Click "听众" role button
      await page.click('#role-listener');

      // Set room name
      await page.fill('#room', ROOM);

      // Click Join
      await page.click('#join');

      // Wait for connection to establish — look for stats showing peer info
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('stats-container');
          return el && el.textContent.includes('peer');
        }, { timeout: 15000 });
        results.push({ id: listenerId, status: 'connected' });
        console.log(`  [${listenerId}] ✓ 已连接`);
      } catch {
        results.push({ id: listenerId, status: 'timeout' });
        console.log(`  [${listenerId}] ✗ 超时（可能已达上限）`);
      }

    } catch (e) {
      results.push({ id: listenerId, status: 'error', error: e.message });
      console.log(`  [${listenerId}] ✗ 错误: ${e.message}`);
    }

    // Small gap between joins to avoid overwhelming the signaling server
    await sleep(500);
  }

  // ── Report ────────────────────────────────────────────────────────
  const connected = results.filter(r => r.status === 'connected').length;
  const failed = results.filter(r => r.status !== 'connected').length;

  console.log('');
  console.log('══════════════════════════════════════');
  console.log(`  结果: ${connected} 成功 / ${failed} 失败 (共 ${LISTENER_COUNT})`);
  console.log('══════════════════════════════════════');

  if (failed > 0) {
    console.log('');
    console.log('失败原因可能是:');
    console.log('  - 主播上行带宽不足 (每个听众 ~320kbps)');
    console.log('  - CPU 编码压力过大');
    console.log('  - 浏览器 PeerConnection 数量限制');
    console.log('  - 可观察主机诊断面板中的 "📤 Out" 码率判断');
  }

  // Keep browser open for 10s so you can check the host's stats panel
  console.log('');
  console.log('10 秒后自动关闭…');
  await sleep(10000);

  await browser.close();
  console.log('完成。');
})();
