import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const TARGET_URL = process.env.EXNESS_URL || 'https://mt5trial15.exness.com';
const ACCOUNT = process.env.EXNESS_ACCOUNT;
const PASSWORD = process.env.EXNESS_PASSWORD;
const SYMBOL = process.env.SYMBOL || 'XAUUSD';
const LOT = parseFloat(process.env.LOT || '0.01');
const SL_DELTA = parseFloat(process.env.SL_DELTA || '3');
const TP_DELTA = parseFloat(process.env.TP_DELTA || '3');
const HEADLESS = process.env.HEADLESS === 'true';

const SCREENSHOTS_DIR = './screenshots';

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

let screenshotCount = 0;

/**
 * Take a screenshot and save it with a sequence number
 */
async function takeScreenshot(page, label) {
  const filename = `${++screenshotCount.toString().padStart(3, '0')}-${label}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`📸 Screenshot: ${filename}`);
}

/**
 * Extract bid price from the order panel by finding the lower of the last two decimal numbers
 */
async function extractBidFromPanel(page) {
  try {
    // Find the Sell button first
    const allButtons = await page.$$('button, [role="button"]');
    let sellButton = null;

    for (const btn of allButtons) {
      const text = await btn.textContent();
      if (text.toLowerCase().includes('sell') && !text.toLowerCase().includes('order')) {
        sellButton = btn;
        break;
      }
    }

    if (!sellButton) {
      console.warn('⚠️  Could not find Sell button, trying first button');
      if (allButtons.length > 0) {
        sellButton = allButtons[0];
      }
    }

    if (!sellButton) {
      console.warn('⚠️  No buttons found');
      return null;
    }

    // Walk up to find the panel container
    const panelText = await page.evaluate((btn) => {
      let current = btn;
      while (current && current !== document.body) {
        // Check if this looks like a panel/dialog
        const style = window.getComputedStyle(current);
        if (style.position === 'absolute' || style.position === 'fixed' || current.getAttribute('role') === 'dialog') {
          return current.innerText;
        }
        current = current.parentElement;
      }
      // Fallback: get text from parent containers
      return btn.parentElement?.parentElement?.innerText || '';
    }, sellButton);

    if (!panelText) {
      console.warn('⚠️  Could not extract panel text');
      return null;
    }

    // Extract numbers with up to 2 decimal places (for XAU)
    const numberRegex = /\d+\.\d{1,2}|\d+/g;
    const matches = panelText.match(numberRegex);

    if (!matches || matches.length < 2) {
      console.warn('⚠️  Could not find price numbers in panel');
      return null;
    }

    // Get the last two numbers and take the lower one
    const last = parseFloat(matches[matches.length - 1]);
    const secondLast = parseFloat(matches[matches.length - 2]);
    const bid = Math.min(last, secondLast);

    console.log(`✓ Extracted bid: ${bid}`);
    return bid;
  } catch (err) {
    console.warn(`⚠️  Error extracting bid: ${err.message}`);
    return null;
  }
}

/**
 * Tag order panel inputs with data-pd-input for later selection
 */
async function tagOrderInputs(page) {
  try {
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
      inputs.forEach((input, idx) => {
        input.setAttribute('data-pd-input', idx.toString());
      });
    });
    console.log(`✓ Tagged ${await page.$$eval('input[data-pd-input]', (els) => els.length)} inputs`);
  } catch (err) {
    console.warn(`⚠️  Error tagging inputs: ${err.message}`);
  }
}

/**
 * Fill order ticket with Volume, Stop Loss, Take Profit
 */
async function fillOrderTicket(page, volume, stopLoss, takeProfit) {
  try {
    // Get all tagged inputs
    const inputs = await page.$$('input[data-pd-input]');

    if (inputs.length < 3) {
      console.warn(`⚠️  Expected 3+ inputs, found ${inputs.length}`);
    }

    // Fill Volume (index 0)
    if (inputs.length > 0) {
      console.log(`📝 Filling Volume: ${volume}`);
      await inputs[0].fill(volume.toString());
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
    }

    // Fill Stop Loss (index 1)
    if (inputs.length > 1) {
      console.log(`📝 Filling Stop Loss: ${stopLoss}`);
      await inputs[1].fill(stopLoss.toFixed(2));
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
    }

    // Fill Take Profit (index 2)
    if (inputs.length > 2) {
      console.log(`📝 Filling Take Profit: ${takeProfit}`);
      await inputs[2].fill(takeProfit.toFixed(2));
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
    }

    console.log('✓ Order ticket filled');
  } catch (err) {
    console.error(`❌ Error filling order ticket: ${err.message}`);
  }
}

/**
 * Find and click Sell button
 */
async function clickSellButton(page) {
  try {
    const allButtons = await page.$$('button, [role="button"]');

    for (const btn of allButtons) {
      const text = await btn.textContent();
      if (text.toLowerCase().includes('sell') && !text.toLowerCase().includes('order')) {
        // Check if button is enabled
        const isDisabled = await btn.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (isDisabled) {
          console.warn('⚠️  Sell button is disabled!');
          return false;
        }
        console.log('✓ Selling...');
        await btn.click();
        return true;
      }
    }

    console.warn('⚠️  Sell button not found');
    return false;
  } catch (err) {
    console.error(`❌ Error clicking Sell button: ${err.message}`);
    return false;
  }
}

/**
 * Handle confirmation modal
 */
async function handleConfirmationModal(page) {
  try {
    // Wait a bit for modal to appear
    await page.waitForTimeout(500);

    // Find confirmation button
    const allButtons = await page.$$('button, [role="button"]');

    for (const btn of allButtons) {
      const text = await btn.textContent().catch(() => '');
      if (
        text.toLowerCase().includes('ok') ||
        text.toLowerCase().includes('confirm') ||
        text.toLowerCase().includes('yes') ||
        text.toLowerCase().includes('place')
      ) {
        console.log(`✓ Clicking confirmation: "${text}"`);
        await btn.click();
        await page.waitForTimeout(1000);
        return true;
      }
    }

    console.log('ℹ️  No confirmation modal found');
    return false;
  } catch (err) {
    console.warn(`⚠️  Error handling confirmation modal: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`🚀 TRADE.JS - Exness MT5 Automated Trading`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`URL: ${TARGET_URL}`);
  console.log(`Account: ${ACCOUNT}`);
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Volume: ${LOT}`);
  console.log(`SL Delta: ${SL_DELTA}`);
  console.log(`TP Delta: ${TP_DELTA}`);
  console.log(`Headless: ${HEADLESS}`);
  console.log(`${'═'.repeat(80)}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    // Step 1: Navigate to login
    console.log('📍 Step 1: Navigate to login...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'login-page');

    // Step 2: Login
    console.log('\n📍 Step 2: Login...');
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

    await takeScreenshot(page, 'after-login');

    // Step 3: Search symbol
    console.log('\n📍 Step 3: Search symbol...');
    try {
      const searchInputs = await page.$$('input[placeholder*="Search"], input[placeholder*="search"]');

      if (searchInputs.length > 0) {
        await searchInputs[0].fill(SYMBOL);
        console.log(`  ✓ Filled search with: ${SYMBOL}`);
        await page.waitForTimeout(1000);

        // Click matching row
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

        // Clear search field to make toolbar visible
        console.log('  Clearing search field...');
        await searchInputs[0].triple_click();
        await page.keyboard.press('Delete');
        await page.waitForTimeout(300);
      }
    } catch (err) {
      console.warn(`⚠️  Symbol search error: ${err.message}`);
    }

    await takeScreenshot(page, 'after-symbol-search');

    // Step 4: Click New Order
    console.log('\n📍 Step 4: Click New Order...');
    try {
      const allButtons = await page.$$('button, [role="button"]');
      let newOrderClicked = false;

      for (const btn of allButtons) {
        const text = await btn.textContent();
        if (text.toLowerCase().includes('new order')) {
          await btn.click();
          console.log(`  ✓ Clicked "New Order"`);
          newOrderClicked = true;
          await page.waitForTimeout(2000);
          break;
        }
      }

      if (!newOrderClicked) {
        console.warn('⚠️  Could not find "New Order" button');
      }
    } catch (err) {
      console.warn(`⚠️  New Order click error: ${err.message}`);
    }

    await takeScreenshot(page, 'order-ticket-open');

    // Step 5: Force order type to Market Execution (value=0)
    console.log('\n📍 Step 5: Force order type to Market Execution...');
    try {
      const selects = await page.$$('select');
      if (selects.length > 0) {
        await selects[0].selectOption('0');
        console.log('  ✓ Set order type to Market Execution');
        await page.waitForTimeout(500);
      } else {
        console.warn('⚠️  No select found for order type');
      }
    } catch (err) {
      console.warn(`⚠️  Error setting order type: ${err.message}`);
    }

    // Step 6: Extract bid price
    console.log('\n📍 Step 6: Extract bid price...');
    const bid = await extractBidFromPanel(page);

    if (!bid) {
      console.error('❌ Could not extract bid price. Aborting.');
      await takeScreenshot(page, 'error-no-bid');
      await browser.close();
      return;
    }

    // Step 7: Compute Stop Loss and Take Profit
    console.log('\n📍 Step 7: Compute Stop Loss and Take Profit...');
    const stopLoss = bid + SL_DELTA;
    const takeProfit = bid - TP_DELTA;

    console.log(`  Bid: ${bid}`);
    console.log(`  SL: ${stopLoss.toFixed(2)} (bid + ${SL_DELTA})`);
    console.log(`  TP: ${takeProfit.toFixed(2)} (bid - ${TP_DELTA})`);

    // Step 8: Tag inputs
    console.log('\n📍 Step 8: Tag order inputs...');
    await tagOrderInputs(page);

    // Step 9: Fill order ticket
    console.log('\n📍 Step 9: Fill order ticket...');
    await fillOrderTicket(page, LOT, stopLoss, takeProfit);

    await takeScreenshot(page, 'order-filled');

    // Step 10: Click Sell button
    console.log('\n📍 Step 10: Click Sell button...');
    const sellClicked = await clickSellButton(page);

    if (!sellClicked) {
      console.warn('⚠️  Sell button click failed');
      await takeScreenshot(page, 'error-sell-failed');
    }

    await takeScreenshot(page, 'after-sell-click');

    // Step 11: Handle confirmation modal
    console.log('\n📍 Step 11: Handle confirmation modal...');
    await handleConfirmationModal(page);

    await takeScreenshot(page, 'after-confirmation');

    console.log('\n✓ Trade execution complete!');

    // Step 12: Leave browser open for verification (headed mode only)
    if (!HEADLESS) {
      console.log('\n⏳ Leaving browser open for 5 seconds for verification...');
      await page.waitForTimeout(5000);
    }

  } catch (error) {
    console.error('❌ Error during trade execution:', error);
    await takeScreenshot(page, 'error-exception');
  } finally {
    await browser.close();
    console.log('\n✓ Browser closed.');
    console.log(`Screenshots saved to: ${SCREENSHOTS_DIR}`);
  }
}

main();
