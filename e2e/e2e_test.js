const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function getSystemChromiumPath() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.MS_EDGE_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);

  for (const executablePath of candidates) {
    if (fs.existsSync(executablePath)) {
      return executablePath;
    }
  }

  return null;
}

async function launchBrowser() {
  const launchOptions = { headless: true };
  const launchAttempts = [
    () => chromium.launch({ ...launchOptions, channel: 'msedge' }),
    () => chromium.launch({ ...launchOptions, channel: 'chrome' }),
  ];

  for (const attempt of launchAttempts) {
    try {
      return await attempt();
    } catch (error) {
      if (!/browserType\.launch/.test(String(error))) {
        throw error;
      }
    }
  }

  const executablePath = getSystemChromiumPath();
  if (executablePath) {
    console.log('Falling back to system browser at', executablePath);
    return chromium.launch({ ...launchOptions, executablePath });
  }

  throw new Error(
    "Playwright's bundled Chromium is not installed and no local Chrome/Edge executable was found. Run 'npx playwright install chromium' or set PLAYWRIGHT_CHROMIUM_PATH to a local browser executable."
  );
}

(async () => {
  const serverUrl = process.env.SERVER_URL || 'http://localhost:3000/';
  console.log('Starting Playwright, connecting to', serverUrl);

  const browser = await launchBrowser();
  console.log('Browser launched');

  // helper to create a context that fakes microphone via WebAudio oscillator
  const makeContextWithFakeMic = async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ac = new AudioCtx();
        const osc = ac.createOscillator();
        const dst = ac.createMediaStreamDestination();
        osc.type = 'sine';
        osc.frequency.value = 440;
        osc.connect(dst);
        try { osc.start(); } catch (e) {}
        return dst.stream;
      };
    });
    return context;
  };

  const ctx1 = await makeContextWithFakeMic();
  const ctx2 = await makeContextWithFakeMic();
  console.log('Contexts created');
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();
  console.log('Pages created');

  await page1.goto(serverUrl);
  await page2.goto(serverUrl);
  console.log('Pages loaded');

  await page1.fill('#room', 'e2e-room');
  await page2.fill('#room', 'e2e-room');

  await page1.click('#join');
  await page2.click('#join');
  console.log('Join buttons clicked');

  // wait for remote audio elements to appear on each page
  await page1.waitForSelector('audio[id^="audio-"]', { timeout: 15000, state: 'attached' });
  console.log('Page 1 remote audio detected');
  await page2.waitForSelector('audio[id^="audio-"]', { timeout: 15000, state: 'attached' });
  console.log('Page 2 remote audio detected');
  console.log('Remote audio elements detected');

  console.log('E2E test passed: remote audio elements detected on both pages');

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(2);
});
