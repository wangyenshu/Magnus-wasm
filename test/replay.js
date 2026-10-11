// replay.js -- feed recorded front-end messages straight to the back end and
// print everything the back end answers (the GUI keeps running alongside).
//   node test/replay.js URL MESSAGES_FILE [SECONDS]
// Record MESSAGES_FILE with  RECORD=file node test/magnus.test.js URL ...
'use strict';
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const fs = require('fs');

const [url, file, secs = '60'] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (process.env.VERBOSE) console.error('[console]', m.text().slice(0, +(process.env.VERBOSE) > 1 ? 20000 : 300)); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof MagnusBackend != 'undefined');
  await page.evaluate(() => {
    window.__out = [];
    const take = MagnusBackend.take;
    MagnusBackend.take = () => { const s = take(); __out.push(s); return s; };
  });
  const drain = async () => {
    const s = await page.evaluate(() => __out.splice(0).join(''));
    if (s) process.stdout.write(s.replace(/\x04/g, '<EOF>\n'));
    return s;
  };
  for (let out = ''; !/boot_done_/.test(out); await sleep(200)) out += await drain();
  await sleep(2000);
  for (const l of lines) {
    await page.evaluate((t) => MagnusBackend.send(t), l + '\n');
    await sleep(1500);
    await drain();
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 1000 * secs) { await drain(); await sleep(250); }
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close();
})();
