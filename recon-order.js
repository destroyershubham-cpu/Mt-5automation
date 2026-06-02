import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const TARGET_URL = process.env.EXNESS_URL || 'https://mt5trial15.exness.com';
const ACCOUNT = process.env.EXNESS_ACCOUNT;
const PASSWORD = process.env.EXNESS_PASSWORD;
const SYMBOL = process.env.SYMBOL || 'XAUUSD';
const RECON_DIR = './recon';

// Ensure recon directory exists
if (!fs.existsSync(RECON_DIR)) {
  fs.mkdirSync(RECON_DIR, { recursive: true });
}

/**
 * Collect all interactive elements from a frame with detailed mapping
 */
async function collectOrderTicketElements(frame) {
  try {
    return await frame.evaluate(() => {
      const elements = [];
      const selectors = [
        'input',
        'button',
        'select',
        'textarea',
        '[role="button"]',
        '[role="combobox"]',
        '[role="listbox"]',
        '[role="slider"]',
      ];

      // Helper function (must be defined here for eval context)
      function findNearestLabel(el) {
        // Check for associated label
        if (el.id) {
          const label = document.querySelector(`label[for="${el.id}"]`);
          if (label) return label.textContent.trim();
        }

        // Look for preceding/sibling label text
        let current = el;
        for (let i = 0; i < 5; i++) {
          const prev = current.previousElementSibling;
          if (prev) {
            if (prev.tagName === 'LABEL' || prev.getAttribute('role') === 'label') {
              return prev.textContent.trim();
            }
            const text = prev.textContent?.trim();
            if (text && text.length > 0 && text.length < 100) {
              return text;
            }
          }
          current = prev || current;
        }

        // Look in parent for nearby text
        const parent = el.parentElement;
        if (parent) {
          const labels = parent.querySelectorAll('label, [role="label"]');
          if (labels.length > 0) {
            return labels[0].textContent.trim();
          }

          const parentText = parent.textContent
            .trim()
            .split('\n')[0]
            .substring(0, 50);
          if (parentText && parentText.length > 0) {
            return parentText;
          }
        }

        // Check aria-label
        if (el.getAttribute('aria-label')) {
          return el.getAttribute('aria-label');
        }

        // Check placeholder
        if (el.placeholder) {
          return `Placeholder: ${el.placeholder}`;
        }

        return '(no label found)';
      }

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';

          if (!isVisible) return;

          const nearestLabel = findNearestLabel(el);

          elements.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            id: el.id || null,
            placeholder: el.placeholder || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            role: el.getAttribute('role') || null,
            value: el.value || el.textContent?.substring(0, 100) || null,
            nearestLabel,
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            classList: Array.from(el.classList),
            dataAttributes: Array.from(el.attributes)
              .filter((attr) => attr.name.startsWith('data-'))
              .reduce((acc, attr) => {
                acc[attr.name] = attr.value;
                return acc;
              }, {}),
          });
        });
      });

      return elements;
    });
  } catch (err) {
    console.warn(`Could not collect elements:`, err.message);
    return [];
  }
}

async function main() {
  console.log(`🔍 Recon Order Ticket: ${TARGET_URL}`);
  console.log(`📁 Account: ${ACCOUNT}`);
  console.log(`📍 Symbol: ${SYMBOL}`);
  console.log(`📁 Saving to ${RECON_DIR}/`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    // Navigate and login
    console.log('\n📍 Step 1: Navigate and login...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Find and fill login fields
    try {
      const accountInputs = await page.$$('input[type="text"], input[name*="account"], input[name*="login"]');
      const passwordInputs = await page.$$('input[type="password"]');

      if (accountInputs.length > 0) {
        await accountInputs[0].fill(ACCOUNT);
        console.log(`  ✓ Filled account`);
      }

      if (passwordInputs.length > 0) {
        await passwordInputs[0].fill(PASSWORD);
        console.log(`  ✓ Filled password`);
      }

      // Click login
      const buttons = await page.$$('button, [role="button"]');
      if (buttons.length > 0) {
        await buttons[0].click();
        console.log(`  ✓ Clicked login`);
      }

      console.log('⏳ Waiting 8 seconds for terminal to load...');
      await page.waitForTimeout(8000);
    } catch (err) {
      console.warn(`⚠️  Login error: ${err.message}`);
    }

    // Step 2: Search for symbol
    console.log('\n📍 Step 2: Search for symbol...');
    try {
      // Find search input
      const searchInputs = await page.$$('input[placeholder*="Search"], input[placeholder*="search"]');
      if (searchInputs.length === 0) {
        console.warn('⚠️  No search input found, trying generic text inputs...');
      }

      if (searchInputs.length > 0) {
        await searchInputs[0].fill(SYMBOL);
        console.log(`  ✓ Filled search with: ${SYMBOL}`);
        await page.waitForTimeout(1000); // Wait for list to filter
      }

      // Try to find and click the matching row
      console.log(`📍 Step 3: Looking for matching row for ${SYMBOL}...`);
      const rows = await page.$$('tr, [role="row"], li');

      let found = false;
      for (const row of rows) {
        const text = await row.textContent();
        if (text.includes(SYMBOL)) {
          await row.click();
          console.log(`  ✓ Clicked on ${SYMBOL} row`);
          found = true;
          await page.waitForTimeout(500);
          break;
        }
      }

      if (!found) {
        console.warn(`⚠️  Did not find ${SYMBOL} in list`);
      }
    } catch (err) {
      console.warn(`⚠️  Symbol search error: ${err.message}`);
    }

    // Step 4: Click New Order button
    console.log('\n📍 Step 4: Clicking "New Order" button...');
    try {
      const allButtons = await page.$$('button, [role="button"]');
      let newOrderClicked = false;

      for (const btn of allButtons) {
        const text = await btn.textContent();
        if (text.toLowerCase().includes('new order') || text.toLowerCase().includes('new')) {
          await btn.click();
          console.log(`  ✓ Clicked "New Order"`);
          newOrderClicked = true;
          await page.waitForTimeout(2000); // Wait for order ticket to open
          break;
        }
      }

      if (!newOrderClicked) {
        console.warn('⚠️  Could not find "New Order" button, trying any button...');
        if (allButtons.length > 0) {
          await allButtons[0].click();
          await page.waitForTimeout(2000);
        }
      }
    } catch (err) {
      console.warn(`⚠️  New Order click error: ${err.message}`);
    }

    // Step 5: Collect order ticket elements
    console.log('\n📍 Step 5: Collecting order ticket elements...');
    const allFrames = page.frames();
    const allElements = [];

    for (let i = 0; i < allFrames.length; i++) {
      const frame = allFrames[i];
      const frameUrl = frame.url();
      const frameTitle = await frame.title().catch(() => '(no title)');

      const elements = await collectOrderTicketElements(frame);
      elements.forEach((el) => {
        allElements.push({
          frameIndex: i,
          frameUrl,
          frameTitle,
          ...el,
        });
      });
    }

    console.log(`  ✓ Found ${allElements.length} interactive elements`);

    // Save elements
    const elementsPath = path.join(RECON_DIR, '13-order-ticket-elements.json');
    fs.writeFileSync(elementsPath, JSON.stringify({ elements: allElements, symbol: SYMBOL }, null, 2));
    console.log(`  ✓ Saved: ${elementsPath}`);

    // Categorize elements by label
    console.log('\n📊 ELEMENT ANALYSIS:');
    console.log('─'.repeat(80));

    const volumeElements = allElements.filter(
      (el) =>
        el.nearestLabel.toLowerCase().includes('volume') ||
        el.nearestLabel.toLowerCase().includes('lot') ||
        el.nearestLabel.toLowerCase().includes('qty') ||
        el.name?.toLowerCase().includes('volume') ||
        el.name?.toLowerCase().includes('lot') ||
        el.ariaLabel?.toLowerCase().includes('volume'),
    );

    const slElements = allElements.filter(
      (el) =>
        el.nearestLabel.toLowerCase().includes('stop loss') ||
        el.nearestLabel.toLowerCase().includes('sl') ||
        el.nearestLabel.toLowerCase().includes('stop') ||
        el.name?.toLowerCase().includes('sl') ||
        el.name?.toLowerCase().includes('stoploss') ||
        el.ariaLabel?.toLowerCase().includes('stop'),
    );

    const tpElements = allElements.filter(
      (el) =>
        el.nearestLabel.toLowerCase().includes('take profit') ||
        el.nearestLabel.toLowerCase().includes('tp') ||
        el.nearestLabel.toLowerCase().includes('profit') ||
        el.name?.toLowerCase().includes('tp') ||
        el.name?.toLowerCase().includes('takeprofit') ||
        el.ariaLabel?.toLowerCase().includes('profit'),
    );

    const typeElements = allElements.filter(
      (el) =>
        el.tag === 'select' ||
        (el.role === 'combobox' && (el.nearestLabel.toLowerCase().includes('type') || el.nearestLabel.toLowerCase().includes('order'))) ||
        el.nearestLabel.toLowerCase().includes('order type') ||
        el.nearestLabel.toLowerCase().includes('order'),
    );

    const sellButtons = allElements.filter(
      (el) =>
        el.tag === 'button' &&
        (el.value?.toLowerCase().includes('sell') ||
          el.nearestLabel.toLowerCase().includes('sell') ||
          el.nearestLabel.toLowerCase().includes('market')),
    );

    console.log('\n🎯 Volume Elements:');
    if (volumeElements.length === 0) {
      console.log('  ⚠️  No Volume elements found');
    }
    volumeElements.forEach((el, idx) => {
      console.log(`  [${idx}] tag="${el.tag}" name="${el.name}" label="${el.nearestLabel}"`);
      console.log(`      id="${el.id}" type="${el.type}"`);
      console.log(`      pos(${el.boundingBox.x}, ${el.boundingBox.y}) size(${el.boundingBox.width}x${el.boundingBox.height})`);
      if (el.id) console.log(`      Selector: #${el.id}`);
      if (el.name) console.log(`      Selector: [name="${el.name}"]`);
    });

    console.log('\n🎯 Stop Loss Elements:');
    if (slElements.length === 0) {
      console.log('  ⚠️  No Stop Loss elements found');
    }
    slElements.forEach((el, idx) => {
      console.log(`  [${idx}] tag="${el.tag}" name="${el.name}" label="${el.nearestLabel}"`);
      console.log(`      id="${el.id}" type="${el.type}"`);
      console.log(`      pos(${el.boundingBox.x}, ${el.boundingBox.y}) size(${el.boundingBox.width}x${el.boundingBox.height})`);
      if (el.id) console.log(`      Selector: #${el.id}`);
      if (el.name) console.log(`      Selector: [name="${el.name}"]`);
    });

    console.log('\n🎯 Take Profit Elements:');
    if (tpElements.length === 0) {
      console.log('  ⚠️  No Take Profit elements found');
    }
    tpElements.forEach((el, idx) => {
      console.log(`  [${idx}] tag="${el.tag}" name="${el.name}" label="${el.nearestLabel}"`);
      console.log(`      id="${el.id}" type="${el.type}"`);
      console.log(`      pos(${el.boundingBox.x}, ${el.boundingBox.y}) size(${el.boundingBox.width}x${el.boundingBox.height})`);
      if (el.id) console.log(`      Selector: #${el.id}`);
      if (el.name) console.log(`      Selector: [name="${el.name}"]`);
    });

    console.log('\n🎯 Order Type Elements:');
    if (typeElements.length === 0) {
      console.log('  ⚠️  No Order Type elements found');
    }
    typeElements.forEach((el, idx) => {
      console.log(`  [${idx}] tag="${el.tag}" name="${el.name}" label="${el.nearestLabel}"`);
      console.log(`      id="${el.id}" role="${el.role}" value="${el.value}"`);
      console.log(`      pos(${el.boundingBox.x}, ${el.boundingBox.y}) size(${el.boundingBox.width}x${el.boundingBox.height})`);
      if (el.id) console.log(`      Selector: #${el.id}`);
      if (el.name) console.log(`      Selector: [name="${el.name}"]`);
    });

    console.log('\n🎯 Sell/Market Buttons:');
    if (sellButtons.length === 0) {
      console.log('  ⚠️  No Sell buttons found');
    }
    sellButtons.forEach((el, idx) => {
      console.log(`  [${idx}] text="${el.value}" label="${el.nearestLabel}"`);
      console.log(`      id="${el.id}" name="${el.name}"`);
      console.log(`      pos(${el.boundingBox.x}, ${el.boundingBox.y}) size(${el.boundingBox.width}x${el.boundingBox.height})`);
      if (el.id) console.log(`      Selector: #${el.id}`);
      if (el.name) console.log(`      Selector: [name="${el.name}"]`);
    });

    // Take screenshot
    console.log('\n📸 Taking screenshot of order ticket...');
    await page.screenshot({
      path: path.join(RECON_DIR, '13-order-ticket.png'),
      fullPage: true,
    });
    console.log(`✓ Saved: ${RECON_DIR}/13-order-ticket.png`);

    console.log('\n✓ Order ticket recon complete!');

  } catch (error) {
    console.error('❌ Error during recon:', error);
  } finally {
    await browser.close();
    console.log('\n✓ Browser closed.');
  }
}

main();
