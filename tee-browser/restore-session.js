#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function restoreSession() {
  const sessionFile = path.join('output', 'amazon-session.json');

  if (!fs.existsSync(sessionFile)) {
    console.error('❌ No saved session found!');
    console.error('   Run `node save-session.js` first to save a session.');
    process.exit(1);
  }

  console.log('Loading saved session...');
  const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

  console.log('Connecting to browser...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

  let context;
  const contexts = browser.contexts();

  if (contexts.length === 0) {
    console.log('Creating new browser context...');
    context = await browser.newContext();
  } else {
    context = contexts[0];
  }

  // Restore cookies
  console.log(`Restoring ${sessionData.cookies.length} cookies...`);
  await context.addCookies(sessionData.cookies);

  // Create or get page
  const pages = context.pages();
  let page;
  if (pages.length === 0) {
    page = await context.newPage();
  } else {
    page = pages[0];
  }

  // Navigate to saved URL or Amazon
  const targetUrl = sessionData.url || 'https://www.amazon.com/gp/cart/view.html';
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Restore localStorage
  if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
    console.log(`Restoring ${Object.keys(sessionData.localStorage).length} localStorage items...`);
    await page.evaluate((storage) => {
      for (const [key, value] of Object.entries(storage)) {
        window.localStorage.setItem(key, value);
      }
    }, sessionData.localStorage);
  }

  console.log('');
  console.log('✅ Session restored successfully!');
  console.log('');
  console.log('Session info:');
  console.log(`  Saved at: ${sessionData.savedAt}`);
  console.log(`  Cookies restored: ${sessionData.cookies.length}`);
  console.log(`  Current page: ${await page.url()}`);
  console.log('');
  console.log('You can now:');
  console.log('  - View at http://localhost:8080 (user: neko, pass: neko)');
  console.log('  - Test verification at http://localhost:3002/amazon-cart/');
  console.log('');
  console.log('Press Ctrl+C to exit (browser will stay open)');

  // Keep running
  await new Promise(() => {});
}

restoreSession().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
