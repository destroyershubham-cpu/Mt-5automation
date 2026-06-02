import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const TARGET_URL = process.env.EXNESS_URL || 'https://mt5trial15.exness.com';
const RECON_DIR = './recon';

// Ensure recon directory exists
if (!fs.existsSync(RECON_DIR)) {
  fs.mkdirSync(RECON_DIR, { recursive: true });
}

async function collectElements(page) {
  return await page.evaluate(() => {
    const elements = [];

    // Helper to get bounding box and visibility
    const getElementInfo = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';

      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        role: el.getAttribute('role') || null,
        visible: isVisible,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        text: el.textContent?.substring(0, 100) || null,
      };
    };

    // Collect from top-level page
    const topLevelSelectors = ['input', 'button', 'select', '[role="button"]'];
    topLevelSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        elements.push({
          source: 'top-level',
          ...getElementInfo(el),
        });
      });
    });

    return elements;
  });
}

async function collectIframeElements(page) {
  const allElements = [];

  // Get top-level elements
  const topLevel = await collectElements(page);
  allElements.push(...topLevel);

  // Get iframes and their contents
  const iframes = await page.$$eval('iframe', (frames) => {
    return frames.map((frame) => ({
      src: frame.src || null,
      name: frame.name || null,
      id: frame.id || null,
    }));
  });

  // Try to access iframe contents (same-origin only)
  for (let i = 0; i < iframes.length; i++) {
    try {
      const frameHandle = (await page.$$('iframe'))[i];
      const frame = await frameHandle.contentFrame();

      if (frame) {
        const iframeElements = await frame.evaluate(() => {
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
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                text: el.textContent?.substring(0, 100) || null,
              });
            });
          });
          return elements;
        });

        iframeElements.forEach((el) => {
          allElements.push({
            source: `iframe-${i}`,
            iframeSrc: iframes[i].src,
            iframeName: iframes[i].name,
            ...el,
          });
        });
      }
    } catch (err) {
      console.warn(`Could not access iframe ${i}:`, err.message);
    }
  }

  return { allElements, iframes };
}

async function main() {
  console.log(`🔍 Probing Exness landing page: ${TARGET_URL}`);
  console.log(`📁 Saving recon data to ${RECON_DIR}/`);

  const browser = await chromium.launch({ headless: false }); // HEADED mode
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    // Navigate
    console.log('⏳ Navigating to target URL...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle' });

    // Wait for page to settle
    console.log('⏳ Waiting for page to settle...');
    await page.waitForTimeout(2000);

    // Log page info
    const title = await page.title();
    const url = page.url();
    console.log(`📄 Page Title: ${title}`);
    console.log(`🔗 Current URL: ${url}`);

    // Screenshot
    console.log('📸 Taking full-page screenshot...');
    await page.screenshot({
      path: path.join(RECON_DIR, '01-landing.png'),
      fullPage: true,
    });
    console.log(`✓ Saved: ${RECON_DIR}/01-landing.png`);

    // Collect elements
    console.log('🔎 Collecting UI elements...');
    const { allElements, iframes } = await collectIframeElements(page);

    // Save elements JSON
    const elementsOutput = {
      timestamp: new Date().toISOString(),
      url,
      title,
      iframes,
      elements: allElements,
    };

    const jsonPath = path.join(RECON_DIR, '01-inputs.json');
    fs.writeFileSync(jsonPath, JSON.stringify(elementsOutput, null, 2));
    console.log(`✓ Saved: ${jsonPath}`);
    console.log(`  Total elements: ${allElements.length}`);
    console.log(`  Total iframes: ${iframes.length}`);

    // List iframes
    if (iframes.length > 0) {
      console.log('\n🖼️  Iframes found:');
      iframes.forEach((iframe, idx) => {
        console.log(`  [${idx}] src="${iframe.src}" name="${iframe.name || '(unnamed)'}"`);
      });
    }

    // List input fields (login-relevant)
    console.log('\n🔑 Input Fields (potential login fields):');
    allElements
      .filter((el) => el.tag === 'input' && el.visible)
      .forEach((el) => {
        console.log(`  - type="${el.type}" name="${el.name || '(unnamed)'}" placeholder="${el.placeholder || '(none)'}" ariaLabel="${el.ariaLabel || '(none)'}"`);
      });

    console.log('\n⏱️  Browser will stay open for 30 seconds. Inspect the page...');
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error('❌ Error during recon:', error);
  } finally {
    await browser.close();
    console.log('✓ Browser closed.');
  }
}

main();
