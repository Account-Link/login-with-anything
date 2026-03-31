#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function saveSession() {
  console.log('Connecting to browser...');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const contexts = browser.contexts();

  if (contexts.length === 0) {
    console.error('❌ No browser context found. Make sure browser is running.');
    process.exit(1);
  }

  const context = contexts[0];

  // Get cookies
  const cookies = await context.cookies();

  // Get local storage from the page
  const pages = context.pages();
  let localStorage = {};

  if (pages.length > 0) {
    const page = pages[0];
    try {
      localStorage = await page.evaluate(() => {
        const data = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          data[key] = window.localStorage.getItem(key);
        }
        return data;
      });
    } catch (e) {
      console.log('⚠️  Could not extract localStorage (page might not be ready)');
    }
  }

  const sessionData = {
    cookies,
    localStorage,
    savedAt: new Date().toISOString(),
    url: pages[0]?.url() || 'unknown'
  };

  const outputDir = 'output';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const sessionFile = path.join(outputDir, 'amazon-session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));

  console.log('✅ Session saved successfully!');
  console.log('');
  console.log('Session details:');
  console.log(`  Cookies: ${cookies.length}`);
  console.log(`  LocalStorage keys: ${Object.keys(localStorage).length}`);
  console.log(`  Current URL: ${sessionData.url}`);
  console.log(`  Saved to: ${sessionFile}`);
  console.log('');
  console.log('To restore this session later, run:');
  console.log('  node restore-session.js');

  await browser.close();
  process.exit(0);
}

saveSession().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
