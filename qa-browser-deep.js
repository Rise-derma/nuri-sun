const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const regionData = fs.readFileSync(path.join(__dirname, 'region-data.js'));
const brokenRegionData = Buffer.from(`window.NURISAN_REGION_SHAPES=${JSON.stringify(Object.fromEntries(
  ['hokkaido','tohoku','kanto','chubu','kinki','chugoku','kyushu','okinawa']
    .map(id => [id, [[[null, [139, 35], [140, 36]]]]])))};`);
const fontPath = require.resolve('@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-700-normal.woff2');
const qaFont = fs.readFileSync(fontPath);

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    path.resolve(__dirname, '../../browser-tmp/chromium')].filter(Boolean);
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { candidates.push(execFileSync('which', [name], { encoding: 'utf8' }).trim()); } catch (_) {}
  }
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

const chromePath = findChrome();
if (!chromePath) throw new Error('Chrome/Chromium not found');

const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  } else if (request.url === '/broken-region.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html.toString('utf8').replace('./region-data.js', './broken-region-data.js'));
  } else if (request.url === '/region-data.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(regionData);
  } else if (request.url === '/broken-region-data.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(brokenRegionData);
  } else if (request.url === '/qa-font.woff2') {
    response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'no-store' });
    response.end(qaFont);
  } else if (request.url === '/favicon.ico') {
    response.writeHead(204); response.end();
  } else {
    response.writeHead(404); response.end('not found');
  }
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
function check(group, name, ok, detail = '') { results.push({ group, name, ok: Boolean(ok), detail }); }

async function load(context, origin, viewport, textScale = 100, preload) {
  const page = await context.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true,
      value: { getCurrentPosition(ok) { ok({ coords: { latitude: 35.681234, longitude: 139.767891 } }); } } });
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ current: { uv_index: 6.2 } }) });
  });
  if (preload) await page.evaluateOnNewDocument(preload);
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror:${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
  page.on('requestfailed', request => errors.push(`request:${request.url()}:${request.failure() && request.failure().errorText}`));
  await page.goto(origin, { waitUntil: 'load' });
  await page.addStyleTag({ content: `@font-face{font-family:QA-JP;src:url('/qa-font.woff2') format('woff2');font-weight:700;font-display:block}html,body,button,select{font-family:QA-JP,sans-serif!important}html{-webkit-text-size-adjust:${textScale}%!important;text-size-adjust:${textScale}%!important}` });
  await page.evaluate(() => document.fonts.ready);
  await wait(80);
  return { page, errors };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote'] });

  const matrices = [
    { name: 'narrow-280x653', viewport: { width: 280, height: 653, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, scale: 100 },
    { name: 'short-320x480', viewport: { width: 320, height: 480, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, scale: 100 },
    { name: 'landscape-667x375', viewport: { width: 667, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, scale: 100 },
    { name: 'landscape-812x375', viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, scale: 100 },
    { name: 'large-2560x1440', viewport: { width: 2560, height: 1440, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, scale: 100 },
    { name: 'text-200pct-375x812', viewport: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, scale: 200 }
  ];

  for (const item of matrices) {
    const context = await browser.createBrowserContext();
    const { page, errors } = await load(context, origin, item.viewport, item.scale);
    const initial = await page.evaluate(() => {
      const sheet = document.querySelector('#onboard .sheet');
      const rect = sheet.getBoundingClientRect();
      return { innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth,
        sheet: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          clientHeight: sheet.clientHeight, scrollHeight: sheet.scrollHeight },
        focus: document.activeElement && document.activeElement.id };
    });
    check('browser', `${item.name}: no startup exceptions`, errors.length === 0, errors.join(' | '));
    check('layout', `${item.name}: no horizontal overflow`, initial.scrollWidth <= initial.innerWidth,
      JSON.stringify({ scrollWidth: initial.scrollWidth, innerWidth: initial.innerWidth }));
    check('layout', `${item.name}: onboarding sheet remains inside viewport`,
      initial.sheet.left >= -0.5 && initial.sheet.right <= initial.innerWidth + 0.5
        && initial.sheet.top >= -0.5 && initial.sheet.bottom <= initial.innerHeight + 0.5,
      JSON.stringify(initial.sheet));
    check('accessibility', `${item.name}: onboarding primary action receives focus`, initial.focus === 'obStart', initial.focus);

    const scrollable = await page.evaluate(() => {
      const sheet = document.querySelector('#onboard .sheet');
      sheet.scrollTop = sheet.scrollHeight;
      const button = document.querySelector('#obStart').getBoundingClientRect();
      const sr = sheet.getBoundingClientRect();
      return { max: sheet.scrollHeight - sheet.clientHeight, reached: sheet.scrollTop,
        buttonTop: button.top, buttonBottom: button.bottom, sheetTop: sr.top, sheetBottom: sr.bottom };
    });
    check('layout', `${item.name}: onboarding action is reachable by internal scrolling`,
      scrollable.buttonTop >= scrollable.sheetTop - 0.5 && scrollable.buttonBottom <= scrollable.sheetBottom + 0.5,
      JSON.stringify(scrollable));
    await page.click('#obStart'); await wait(80);

    await page.evaluate(() => {
      S.coins = 999; S.coinsTotal = 999; PARTS.forEach(part => { S.parts[part.id] = 1; });
      fixWear(); renderAll(); switchTab('dress', true);
    });
    await wait(60);
    const dress = await page.evaluate(() => {
      const tab = document.querySelector('.tabinner').getBoundingClientRect();
      const scroller = document.scrollingElement;
      scroller.scrollTop = scroller.scrollHeight;
      const last = document.querySelector('#dressGrid .tile:last-child').getBoundingClientRect();
      const clipped = [...document.querySelectorAll('#view-dress button')].filter(button => {
        const r = button.getBoundingClientRect();
        return r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5);
      }).map(button => button.id || button.dataset.id || button.dataset.c);
      return { pageWidth: document.documentElement.scrollWidth, innerWidth,
        last: { top: last.top, bottom: last.bottom }, tab: { top: tab.top, bottom: tab.bottom }, clipped };
    });
    check('layout', `${item.name}: full dress grid stays horizontally usable`,
      dress.pageWidth <= dress.innerWidth && dress.clipped.length === 0, JSON.stringify(dress));
    check('layout', `${item.name}: last dress action can scroll above fixed tabs`,
      dress.last.bottom <= dress.tab.top + 0.5, JSON.stringify({ last: dress.last, tab: dress.tab }));

    await page.click('#gearBtn'); await wait(30);
    const settings = await page.evaluate(() => {
      const sheet = document.querySelector('#settings .sheet');
      sheet.scrollTop = sheet.scrollHeight;
      const close = document.querySelector('#setClose').getBoundingClientRect();
      const sr = sheet.getBoundingClientRect();
      return { max: sheet.scrollHeight - sheet.clientHeight, reached: sheet.scrollTop,
        closeTop: close.top, closeBottom: close.bottom, sheetTop: sr.top, sheetBottom: sr.bottom,
        bodyY: scrollY };
    });
    check('layout', `${item.name}: settings close action is reachable`,
      settings.closeTop >= settings.sheetTop - 0.5 && settings.closeBottom <= settings.sheetBottom + 0.5,
      JSON.stringify(settings));
    check('layout', `${item.name}: modal scrolling does not move background`, settings.bodyY >= 0, JSON.stringify(settings));
    check('browser', `${item.name}: interaction path has no exceptions`, errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // Confirmation belongs to one tile and must be cancelled by changing categories or leaving the view.
  {
    const context = await browser.createBrowserContext();
    const { page, errors } = await load(context, origin, { width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.click('#obStart'); await wait(60);
    await page.evaluate(async () => {
      await mutateState(() => { S.coins = 50; S.coinsTotal = 1000; return { changed:true }; });
      renderAll(); switchTab('dress', true);
    });
    await wait(50);
    await page.evaluate(() => { const tile = document.querySelector('#dressGrid .tile.lock.buyable'); tile.scrollIntoView({ block:'center' }); tile.click(); });
    await wait(20);
    const pending = await page.evaluate(() => ({ id: eval('buyPending'), confirms: document.querySelectorAll('.tile.confirm').length }));
    const nextCategory = await page.$$('#catTabs .cat');
    if (nextCategory.length > 1) await nextCategory[1].click();
    const afterCategory = await page.evaluate(() => ({ id: eval('buyPending'), confirms: document.querySelectorAll('.tile.confirm').length }));
    check('ui', 'purchase confirmation is cancelled when category changes',
      Boolean(pending.id) && pending.confirms === 1 && afterCategory.id === null && afterCategory.confirms === 0,
      JSON.stringify({ pending, afterCategory }));
    check('browser', 'purchase confirmation cancellation has no exception', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // Browsers without Web Locks use the packaged localStorage lease; three overlapping writes must still serialize.
  {
    const context = await browser.createBrowserContext();
    const viewport = { width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
    const noLocks = () => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); };
    const a = await load(context, origin, viewport, 100, noLocks);
    await a.page.evaluate(() => localStorage.clear()); await a.page.reload({ waitUntil: 'load' }); await wait(60);
    await a.page.click('#obStart'); await wait(60);
    const b = await load(context, origin, viewport, 100, noLocks);
    const c = await load(context, origin, viewport, 100, noLocks);
    const tasks = [
      a.page.evaluate(() => mutateState(async () => { await new Promise(resolve => setTimeout(resolve, 60)); S.coins += 1; return { changed:true }; })),
      b.page.evaluate(() => mutateState(async () => { await new Promise(resolve => setTimeout(resolve, 30)); S.intervalMin = 120; return { changed:true }; })),
      c.page.evaluate(() => mutateState(async () => { S.region = 'chubu'; S.regionManual = true; return { changed:true }; }))
    ];
    await Promise.all(tasks); await wait(100);
    const saved = await a.page.evaluate(() => JSON.parse(localStorage.getItem('nurisan-v1')));
    const errors = [...a.errors, ...b.errors, ...c.errors];
    check('concurrency', 'localStorage lease preserves three overlapping writes without Web Locks',
      saved.coins === 1 && saved.intervalMin === 120 && saved.region === 'chubu' && saved.regionManual,
      JSON.stringify({ coins: saved.coins, intervalMin: saved.intervalMin, region: saved.region,
        regionManual: saved.regionManual }));
    check('browser', 'localStorage lease scenario has no exceptions', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // The storage probe may fit while the real state does not; the first-run dialog must show and later clear the warning.
  {
    const context = await browser.createBrowserContext();
    const preload = () => {
      window.__allowStateWrites = false;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === 'nurisan-v1' && !window.__allowStateWrites)
          throw new DOMException('quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    };
    const x = await load(context, origin,
      { width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, 100, preload);
    const before = await x.page.evaluate(() => ({ shown: document.querySelector('#onboardStatus').classList.contains('show'),
      text: document.querySelector('#onboardStatus').textContent, failed: eval('stateWriteFailed') }));
    await x.page.evaluate(() => { window.__allowStateWrites = true; });
    await x.page.click('#obStart'); await wait(80);
    const after = await x.page.evaluate(() => ({ onboard: JSON.parse(localStorage.getItem('nurisan-v1')).onboard,
      localShown: document.querySelector('#onboardStatus').classList.contains('show'),
      bannerShown: document.querySelector('#banner').classList.contains('show'), failed: eval('stateWriteFailed') }));
    check('persistence', 'real initial quota failure is visible in first-run dialog',
      before.shown && before.failed && before.text.includes('ほぞんできなかった'), JSON.stringify(before));
    check('persistence', 'successful retry clears the real quota warning and persists consent',
      after.onboard && !after.localShown && !after.bannerShown && !after.failed, JSON.stringify(after));
    check('browser', 'real quota recovery has no exceptions', x.errors.length === 0, x.errors.join(' | '));
    await context.close();
  }

  // A syntactically valid but structurally broken boundary file must degrade to manual-region mode without exceptions.
  {
    const context = await browser.createBrowserContext();
    const x = await load(context, origin + 'broken-region.html',
      { width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const before = await x.page.evaluate(() => ({ available: eval('regionDataAvailable'),
      shown: document.querySelector('#onboardStatus').classList.contains('show'),
      text: document.querySelector('#onboardStatus').textContent }));
    await x.page.click('#obStart'); await wait(80);
    const after = await x.page.evaluate(() => ({ badge: document.querySelector('#uvBadge').textContent,
      warning: document.querySelector('#bannerText').textContent,
      shown: document.querySelector('#banner').classList.contains('show') }));
    check('region', 'broken nested boundary file stays operational with a visible manual-region warning',
      !before.available && before.shown && before.text.includes('ちいきデータ')
        && after.shown && after.warning.includes('せってい'), JSON.stringify({ before, after }));
    check('browser', 'broken nested boundary file causes no browser exception', x.errors.length === 0, x.errors.join(' | '));
    await context.close();
  }

  await browser.close(); server.close();
  const failed = results.filter(result => !result.ok);
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}\t${result.group}\t${result.name}\t${result.detail}`);
  console.log(`SUMMARY\t${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (failed.length) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  try { server.close(); } catch (_) {}
  process.exitCode = 1;
});
