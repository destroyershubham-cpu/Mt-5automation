import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const TARGET_URL = process.env.EXNESS_URL || 'https://mt5trial15.exness.com';
const ACCOUNT = process.env.EXNESS_ACCOUNT;
const PASSWORD = process.env.EXNESS_PASSWORD;
const RECON_DIR = './recon';

// Ensure recon directory exists
if (!fs.existsSync(RECON_DIR)) {
  fs.mkdirSync(RECON_DIR, { recursive: true });
}

// WebSocket frame capture
const wsFrames = [];
const maxFrames = 200;
const maxPayloadChars = 800;

function captureWsFrame(direction, payload) {
  if (wsFrames.length >= maxFrames) return;

  let payloadStr = '';
  let payloadType = 'unknown';

  try {
    // Try to detect payload type
    if (typeof payload === 'string') {
      payloadType = 'text';
      payloadStr = payload.substring(0, maxPayloadChars);
    } else if (Buffer.isBuffer(payload)) {
      payloadType = 'binary';
      // Try to decode as UTF-8 or hex
      try {
        payloadStr = payload.toString('utf8').substring(0, maxPayloadChars);
      } catch {
        payloadStr = payload.toString('hex').substring(0, maxPayloadChars);
        payloadType = 'binary-hex';
      }
    } else if (payload instanceof ArrayBuffer) {
      payloadType = 'arraybuffer';
      const view = new Uint8Array(payload);
      payloadStr = Buffer.from(view).toString('hex').substring(0, maxPayloadChars);
    } else {
      payloadStr = String(payload).substring(0, maxPayloadChars);
    }
  } catch (e) {
    payloadStr = '(error parsing payload)';
  }

  wsFrames.push({
    timestamp: new Date().toISOString(),
    direction, // 'sent' or 'received'
    payloadType,
    payloadLength: typeof payload === 'string' ? payload.length : payload?.length || 0,
    payload: payloadStr,
  });
}

async function collectFrameElements(frame) {
  try {
    return await frame.evaluate(() => {
      const elements = [];
      const selectors = ['input', 'button', 'select', '[role="button"]'];

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';

          elements.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            id: el.id || null,
            placeholder: el.placeholder || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            role: el.getAttribute('role') || null,
            visible: isVisible,
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            text: el.textContent?.substring(0, 100) || null,
          });
        });
      });

      return elements;
    });
  } catch (err) {
    console.warn(`  Could not collect elements:`, err.message);
    return [];
  }
}

async function main() {
  console.log(`🔍 Recon Exness MT5 Trading Terminal: ${TARGET_URL}`);
  console.log(`📁 Account: ${ACCOUNT}`);
  console.log(`📁 Saving to ${RECON_DIR}/`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    // Screenshot 1: Before login
    console.log('\n📸 [1/3] Taking screenshot BEFORE login...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.screenshot({
      path: path.join(RECON_DIR, '02-before-login.png'),
      fullPage: true,
    });
    console.log(`✓ Saved: ${RECON_DIR}/02-before-login.png`);

    // Setup WebSocket listener BEFORE navigation
    console.log('\n🌐 Setting up WebSocket capture...');
    page.on('websocket', (ws) => {
      console.log(`  WS connected: ${ws.url()}`);

      ws.on('framesent', (payload) => {
        captureWsFrame('sent', payload);
      });

      ws.on('framereceived', (payload) => {
        captureWsFrame('received', payload);
      });

      ws.on('close', () => {
        console.log(`  WS closed`);
      });
    });

    // Attempt login
    console.log('\n🔐 Attempting login with Exness account...');
    try {
      // Wait for login form
      await page.waitForSelector('input[type="text"], input[name*="account"], input[name*="login"]', { timeout: 5000 });

      // Find and fill login fields
      const accountInputs = await page.$$('input[type="text"], input[name*="account"], input[name*="login"]');
      const passwordInputs = await page.$$('input[type="password"]');

      if (accountInputs.length > 0) {
        console.log(`  Found ${accountInputs.length} text input(s)`);
        await accountInputs[0].fill(ACCOUNT);
        console.log(`  ✓ Filled account: ${ACCOUNT}`);
      }

      if (passwordInputs.length > 0) {
        console.log(`  Found ${passwordInputs.length} password input(s)`);
        await passwordInputs[0].fill(PASSWORD);
        console.log(`  ✓ Filled password`);
      }

      // Find and click login button
      const buttons = await page.$$('button, [role="button"]');
      if (buttons.length > 0) {
        console.log(`  Found ${buttons.length} button(s), clicking login...`);
        await buttons[0].click();
      }

      console.log('⏳ Waiting 8 seconds for terminal to populate...');
      await page.waitForTimeout(8000);
    } catch (err) {
      console.warn(`⚠️  Login attempt failed: ${err.message}`);
      console.log('⏳ Still waiting 8 seconds for page to settle...');
      await page.waitForTimeout(8000);
    }

    // Screenshot 2: Immediately after login/settle
    console.log('\n📸 [2/3] Taking screenshot AFTER login/settle...');
    await page.screenshot({
      path: path.join(RECON_DIR, '03-after-login.png'),
      fullPage: true,
    });
    console.log(`✓ Saved: ${RECON_DIR}/03-after-login.png`);

    // Wait another 8 seconds
    console.log('\n⏳ Waiting another 8 seconds for full populate...');
    await page.waitForTimeout(8000);

    // Screenshot 3: After 8 more seconds
    console.log('\n📸 [3/3] Taking screenshot AFTER additional 8s settle...');
    await page.screenshot({
      path: path.join(RECON_DIR, '03-final.png'),
      fullPage: true,
    });
    console.log(`✓ Saved: ${RECON_DIR}/03-final.png`);

    // Save WebSocket frames
    console.log('\n🌐 Saving WebSocket frames...');
    const wsPath = path.join(RECON_DIR, '04-ws.json');
    fs.writeFileSync(wsPath, JSON.stringify({ frames: wsFrames.slice(0, maxFrames) }, null, 2));
    console.log(`✓ Saved: ${wsPath}`);
    console.log(`  Captured ${wsFrames.length} WebSocket frames`);

    // List all frames
    console.log('\n🖼️  Inspecting page frames...');
    const allFrames = page.frames();
    console.log(`  Total frames: ${allFrames.length}`);

    const allInteractiveElements = [];

    for (let i = 0; i < allFrames.length; i++) {
      const frame = allFrames[i];
      const frameUrl = frame.url();
      const frameTitle = await frame.title().catch(() => '(no title)');

      console.log(`\n  [Frame ${i}]`);
      console.log(`    URL: ${frameUrl}`);
      console.log(`    Title: ${frameTitle}`);

      // Get inner HTML
      const htmlPath = path.join(RECON_DIR, `04-frame-${i}.html`);
      try {
        const html = await frame.content();
        fs.writeFileSync(htmlPath, html);
        console.log(`    ✓ HTML saved: ${path.basename(htmlPath)}`);
      } catch (err) {
        console.warn(`    ⚠️  Could not get HTML: ${err.message}`);
      }

      // Collect interactive elements
      const elements = await collectFrameElements(frame);
      if (elements.length > 0) {
        console.log(`    ✓ Found ${elements.length} interactive element(s)`);
      }

      elements.forEach((el) => {
        allInteractiveElements.push({
          frameIndex: i,
          frameUrl,
          frameTitle,
          ...el,
        });
      });
    }

    // Save all interactive elements
    const interactivePath = path.join(RECON_DIR, '04-all-interactive.json');
    fs.writeFileSync(interactivePath, JSON.stringify({ elements: allInteractiveElements }, null, 2));
    console.log(`\n✓ Saved all interactive elements: ${interactivePath}`);
    console.log(`  Total elements across all frames: ${allInteractiveElements.length}`);

    // Analysis
    console.log('\n📊 ANALYSIS:');
    console.log('─'.repeat(60));

    // Detect rendering type
    const hasCanvas = await page.$$eval('canvas', (els) => els.length > 0).catch(() => false);
    const hasSvg = await page.$$eval('svg', (els) => els.length > 0).catch(() => false);
    const hasDom = allInteractiveElements.length > 0;

    console.log('\nRendering Type:');
    if (hasCanvas && !hasDom) console.log('  → CANVAS-RENDERED (pure canvas, no DOM elements)');
    else if (hasDom && !hasCanvas) console.log('  → DOM-RENDERED (interactive elements in DOM)');
    else if (hasCanvas && hasDom) console.log('  → MIXED (canvas + DOM elements)');
    else console.log('  → UNKNOWN (no canvas or DOM elements detected)');

    // WebSocket payload analysis
    if (wsFrames.length > 0) {
      const payloadTypes = new Set(wsFrames.map((f) => f.payloadType));
      console.log('\nWebSocket Payload Types:');
      payloadTypes.forEach((type) => {
        const count = wsFrames.filter((f) => f.payloadType === type).length;
        console.log(`  → ${type}: ${count} frames`);
      });

      // Check if it looks like JSON
      const firstFrame = wsFrames.find((f) => f.payload.startsWith('{') || f.payload.startsWith('['));
      if (firstFrame) {
        console.log(`\nSample JSON payload detected (first 100 chars):`);
        console.log(`  ${firstFrame.payload.substring(0, 100)}...`);
      } else {
        console.log('\n⚠️  No JSON payloads detected. Likely encrypted binary or protobuf.');
      }
    }

    console.log('\n✓ Recon complete. Check ./recon/ for all files.');

  } catch (error) {
    console.error('❌ Error during recon:', error);
  } finally {
    await browser.close();
    console.log('\n✓ Browser closed.');
  }
}

main();
