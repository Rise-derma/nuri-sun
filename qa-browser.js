const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const bundledHtml = fs.existsSync(path.resolve('./nuri-sun-web.html')) ? './nuri-sun-web.html' : './index.html';
const htmlPath = path.resolve(process.env.NURISAN_HTML || bundledHtml);
const html = fs.readFileSync(htmlPath);
const regionData = fs.readFileSync(path.join(path.dirname(htmlPath), 'region-data.js'));
const fontPath = require.resolve('@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-700-normal.woff2');
const qaFont = fs.readFileSync(fontPath);
const axeSource = require('axe-core').source;
function findChrome(){
  const candidates = [process.env.CHROME_PATH,
    '/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.resolve(__dirname, '../../browser-tmp/chromium')].filter(Boolean);
  const winRoots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of winRoots){
    candidates.push(path.join(root,'Google','Chrome','Application','chrome.exe'));
    candidates.push(path.join(root,'Chromium','Application','chrome.exe'));
  }
  for (const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
    try { candidates.push(execFileSync('which',[name],{encoding:'utf8'}).trim()); } catch(e){}
  }
  return candidates.find(p => p && fs.existsSync(p));
}
const chromePath = findChrome();
if (!chromePath) throw new Error('Chrome/Chromium was not found. Set CHROME_PATH and retry.');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } else if (req.url === '/missing-region.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html.toString('utf8').replace('./region-data.js','./missing-region-data.js'));
  } else if (req.url === '/qa-font.woff2') {
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'no-store' });
    res.end(qaFont);
  } else if (req.url === '/region-data.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(regionData);
  } else if (req.url === '/favicon.ico') {
    res.writeHead(204); res.end();
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: Boolean(ok), detail });
}
const overlap = (a,b) => Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))
  * Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));

async function installStubs(page) {
  await page.evaluateOnNewDocument(() => {
    window.__geoCalls = 0;
    window.__fetchCalls = 0;
    const geo = {
      getCurrentPosition(ok) {
        window.__geoCalls++;
        ok({ coords: { latitude: 35.681234, longitude: 139.767891 } });
      }
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geo });
    window.fetch = async url => {
      window.__fetchCalls++;
      window.__lastFetch = String(url);
      return { ok: true, status: 200, json: async () => ({ current: { uv_index: 6.26 } }) };
    };
  });
}

async function loadPage(context, origin, viewport, preload) {
  const page = await context.newPage();
  await page.setViewport(viewport);
  await installStubs(page);
  if (preload) await page.evaluateOnNewDocument(preload);
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', req => errors.push(`requestfailed: ${req.url()} ${req.failure() && req.failure().errorText}`));
  await page.goto(origin, { waitUntil: 'load' });
  await page.addStyleTag({ content: `@font-face{font-family:QA-JP;src:url('/qa-font.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:block}html,body,button,select{font-family:QA-JP,sans-serif!important}` });
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 80));
  return { page, errors };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}/`;
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
  });
  const shots = path.resolve(process.env.NURISAN_SHOTS || path.join(os.tmpdir(), 'nuri-sun-browser-shots'));
  fs.mkdirSync(shots, { recursive: true });

  const viewports = [
    { name: 'small-320x568', width: 320, height: 568, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    { name: 'iphone-375x812', width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    { name: 'wide-430x932', width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    { name: 'desktop-1280x800', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
  ];

  for (const vp of viewports) {
    const context = await browser.createBrowserContext();
    const { page, errors } = await loadPage(context, origin, vp);

    const initial = await page.evaluate(() => ({
      geoCalls: window.__geoCalls,
      onboard: document.querySelector('#onboard').classList.contains('show'),
      focus: document.activeElement && document.activeElement.id,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      appRight: document.querySelector('#app').getBoundingClientRect().right,
      tab: (() => { const r = document.querySelector('.tabinner').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; })()
      ,onboardScroll: (() => {
        const sheet = document.querySelector('#onboard .sheet');
        const button = document.querySelector('#obStart');
        const sr = sheet.getBoundingClientRect(), br = button.getBoundingClientRect();
        return { clientHeight: sheet.clientHeight, scrollHeight: sheet.scrollHeight, buttonTop: br.top, buttonBottom: br.bottom, sheetTop: sr.top, sheetBottom: sr.bottom };
      })()
    }));
    check('browser', `${vp.name}: no startup browser errors`, errors.length === 0, errors.join(' | '));
    check('browser', `${vp.name}: no pre-consent geolocation`, initial.geoCalls === 0, `calls=${initial.geoCalls}`);
    check('layout', `${vp.name}: no horizontal overflow`, initial.scrollWidth <= initial.innerWidth,
      `scrollWidth=${initial.scrollWidth}, innerWidth=${initial.innerWidth}`);
    check('layout', `${vp.name}: tab bar stays within viewport`, initial.tab.left >= 0 && initial.tab.right <= initial.innerWidth + 0.1,
      JSON.stringify(initial.tab));
    check('accessibility', `${vp.name}: onboarding receives focus`, initial.onboard && initial.focus === 'obStart',
      `onboard=${initial.onboard}, focus=${initial.focus}`);
    await page.keyboard.press('Tab');
    const onboardTabFocus = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      inside: document.querySelector('#onboard').contains(document.activeElement)
    }));
    check('accessibility', `${vp.name}: onboarding traps keyboard focus`, onboardTabFocus.inside,
      JSON.stringify(onboardTabFocus));
    check('layout', `${vp.name}: start button is visible without scrolling onboarding`, initial.onboardScroll.buttonBottom <= initial.onboardScroll.sheetBottom + 0.5,
      JSON.stringify(initial.onboardScroll));

    if (vp.name === 'iphone-375x812') {
      const privacy = await page.evaluate(() => {
        const text = document.querySelector('#onboardPrivacy').textContent;
        const link = document.querySelector('#onboardPrivacyLink');
        const r = document.querySelector('#onboardPrivacy').getBoundingClientRect();
        return { text, href:link.href, target:link.target, rel:link.rel,
          visible:r.width>0&&r.height>0&&r.bottom<=innerHeight+0.5 };
      });
      check('privacy', 'Open-Meteo IP/location log retention is visibly disclosed before consent',
        privacy.visible&&privacy.text.includes('IPアドレス')&&privacy.text.includes('90日後')
          &&privacy.href==='https://open-meteo.com/en/terms'&&privacy.target==='_blank'&&privacy.rel.includes('noopener'),
        JSON.stringify(privacy));
      await page.addScriptTag({ content: axeSource });
      const axeInitial = await page.evaluate(async () => {
        const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help,
          nodes: v.nodes.map(n => ({ target:n.target, html:n.html, summary:n.failureSummary })) }));
      });
      check('accessibility', 'axe reports no WCAG violations on onboarding', axeInitial.length === 0, JSON.stringify(axeInitial));
    }

    await page.screenshot({ path: path.join(shots, `${vp.name}-home.png`), fullPage: true });
    await page.click('#obStart');
    await new Promise(r => setTimeout(r, 100));
    const consent = await page.evaluate(() => ({ geo: window.__geoCalls, fetch: window.__fetchCalls, url: window.__lastFetch || '', badge: document.querySelector('#uvBadge').textContent }));
    check('browser', `${vp.name}: consent triggers one rounded location request`, consent.geo === 1 && consent.fetch === 1 && consent.url.includes('35.68') && consent.url.includes('139.77') && !consent.url.includes('35.681234'), JSON.stringify(consent));

    await page.click('#nuttaBtn');
    await new Promise(r => setTimeout(r, 1100));
    const reward = await page.evaluate(() => ({
      shown: document.querySelector('#gacha').classList.contains('show'),
      focus: document.activeElement && document.activeElement.id,
      total: JSON.parse(localStorage.getItem('nurisan-v1')).total,
      toastOverlap: (() => {
        const a = document.querySelector('#toast').getBoundingClientRect();
        const b = document.querySelector('#gNext').getBoundingClientRect();
        if (!document.querySelector('#toast').classList.contains('show')) return 0;
        return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      })()
    }));
    check('browser', `${vp.name}: first record persists and reward opens`, reward.shown && reward.total === 1, JSON.stringify(reward));
    check('accessibility', `${vp.name}: reward dialog receives focus`, reward.shown && ['gWear', 'gNext'].includes(reward.focus), `focus=${reward.focus}`);
    await page.keyboard.press('Tab');
    const rewardTabFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('accessibility', `${vp.name}: reward dialog traps keyboard focus`, ['gWear', 'gNext'].includes(rewardTabFocus), `focus=${rewardTabFocus}`);
    check('layout', `${vp.name}: welcome toast does not cover reward action`, reward.toastOverlap === 0, `overlapArea=${reward.toastOverlap}`);
    if (vp.name === 'iphone-375x812') {
      const axeReward = await page.evaluate(async () => {
        const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
      });
      check('accessibility', 'axe reports no WCAG violations on reward dialog', axeReward.length === 0, JSON.stringify(axeReward));
    }
    await page.screenshot({ path: path.join(shots, `${vp.name}-reward.png`), fullPage: true });
    await page.click('#gNext');
    await new Promise(r => setTimeout(r, 80));

    for (const v of ['dress', 'zukan', 'log', 'home']) {
      await page.click(`.tab[data-v="${v}"]`);
      const active = await page.evaluate(name => ({
        views: document.querySelectorAll('.view.active').length,
        target: document.querySelector(`#view-${name}`).classList.contains('active'),
        tab: document.querySelector(`.tab[data-v="${name}"]`).classList.contains('on')
      }), v);
      check('browser', `${vp.name}: ${v} tab switches cleanly`, active.views === 1 && active.target && active.tab, JSON.stringify(active));
      if (vp.name === 'iphone-375x812') {
        const axeView = await page.evaluate(async () => {
          const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
          return r.violations.map(x => ({ id:x.id, impact:x.impact,
            nodes:x.nodes.map(n => ({ target:n.target, html:n.html, summary:n.failureSummary })) }));
        });
        check('accessibility', `axe reports no WCAG violations on ${v} view`, axeView.length === 0, JSON.stringify(axeView));
      }
    }

    await page.click('#gearBtn');
    const settingFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('accessibility', `${vp.name}: settings focuses its first control`, settingFocus === 'regionSel', `focus=${settingFocus}`);
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    const settingTabFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('accessibility', `${vp.name}: settings wraps backward focus to its last control`, settingTabFocus === 'setClose', `focus=${settingTabFocus}`);
    if (vp.name === 'iphone-375x812') {
      const axeSettings = await page.evaluate(async () => {
        const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map(x => ({ id:x.id, impact:x.impact,
          nodes:x.nodes.map(n => ({ target:n.target, html:n.html, summary:n.failureSummary })) }));
      });
      check('accessibility', 'axe reports no WCAG violations on settings dialog', axeSettings.length === 0, JSON.stringify(axeSettings));
    }
    await page.click('#intervalSeg button[data-min="120"]');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('nurisan-v1')).intervalMin === 120);
    const beforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem('nurisan-v1')).intervalMin);
    check('settings', `${vp.name}: 2-hour choice is saved before reload`, beforeReload === 120, `value=${beforeReload}`);
    await page.click('#setClose');
    await page.reload({ waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 80));
    const afterReload = await page.evaluate(() => ({
      saved: JSON.parse(localStorage.getItem('nurisan-v1')).intervalMin,
      selected: [...document.querySelectorAll('#intervalSeg button')].find(b => b.classList.contains('on'))?.dataset.min
    }));
    check('settings', `${vp.name}: 2-hour choice survives reload`, afterReload.saved === 120 && afterReload.selected === '120', JSON.stringify(afterReload));

    await page.click('#gearBtn');
    await page.click('#resetBtn');
    await page.click('#resetBtn');
    await new Promise(r => setTimeout(r, 80));
    const reset = await page.evaluate(() => ({
      onboard: document.querySelector('#onboard').classList.contains('show'),
      stateOnboard: eval('S.onboard'),
      liveUvStarted: eval('liveUvStarted'),
      liveTimer: eval('liveUvTimer!=null'),
      lastPos: eval('lastPos'),
      uvLive: eval('uvLive'),
      geoCalls: window.__geoCalls
    }));
    check('privacy', `${vp.name}: reset returns to onboarding`, reset.onboard && reset.stateOnboard === false, JSON.stringify(reset));
    check('privacy', `${vp.name}: reset stops location runtime`, !reset.liveUvStarted && !reset.liveTimer && reset.lastPos === null && reset.uvLive === null, JSON.stringify(reset));
    const callsAtReset = reset.geoCalls;
    await page.click('#obStart');
    await new Promise(r => setTimeout(r, 80));
    const callsAfterReconsent = await page.evaluate(() => window.__geoCalls);
    check('privacy', `${vp.name}: re-consent refreshes position immediately`, callsAfterReconsent === callsAtReset + 1,
      `before=${callsAtReset}, after=${callsAfterReconsent}`);

    const clipping = await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const visible = [...document.querySelectorAll('button')].filter(el => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      return visible.filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < -0.5 || r.right > vw + 0.5 || (getComputedStyle(el).position === 'fixed' && (r.top < -0.5 || r.bottom > vh + 0.5));
      }).map(el => ({ id: el.id, cls: el.className, rect: el.getBoundingClientRect().toJSON() }));
    });
    check('layout', `${vp.name}: visible buttons are not horizontally clipped`, clipping.length === 0, JSON.stringify(clipping));

    await context.close();
  }

  // Modal feedback, focus, background scroll and tab scroll restoration on a small phone.
  {
    const context = await browser.createBrowserContext();
    const { page, errors } = await loadPage(context, origin,
      { width:320, height:568, deviceScaleFactor:1, isMobile:true, hasTouch:true });
    const initialY = await page.evaluate(() => scrollY);
    await page.mouse.move(2,2); await page.mouse.wheel({deltaY:900}); await new Promise(r=>setTimeout(r,40));
    const lockedY = await page.evaluate(() => scrollY);
    check('layout','onboarding prevents background scrolling',lockedY === initialY,`before=${initialY},after=${lockedY}`);
    await page.click('#obStart'); await new Promise(r=>setTimeout(r,60));
    const startFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('accessibility','starting onboarding focuses the primary action',startFocus === 'nuttaBtn',`focus=${startFocus}`);

    await page.click('.tab[data-v="zukan"]');
    await page.evaluate(() => scrollTo(0,document.documentElement.scrollHeight)); await new Promise(r=>setTimeout(r,40));
    await page.click('.tab[data-v="home"]'); await new Promise(r=>setTimeout(r,60));
    const restored = await page.evaluate(() => ({y:scrollY,button:document.querySelector('#nuttaBtn').getBoundingClientRect().toJSON()}));
    check('layout','returning home restores its own scroll position',restored.y === 0 && restored.button.top >= 0,JSON.stringify(restored));

    await page.click('#gearBtn');
    const modalY = await page.evaluate(() => scrollY);
    await page.click('#intervalSeg button[data-min="120"]'); await new Promise(r=>setTimeout(r,50));
    const feedback = await page.evaluate(() => {
      const status=document.querySelector('#settingsStatus'),close=document.querySelector('#setClose'),reset=document.querySelector('#resetBtn');
      return {local:status.classList.contains('show'),text:status.textContent,global:document.querySelector('#toast').classList.contains('show'),
        status:status.getBoundingClientRect().toJSON(),close:close.getBoundingClientRect().toJSON(),reset:reset.getBoundingClientRect().toJSON()};
    });
    check('accessibility','settings feedback stays inside the active dialog',feedback.local && !feedback.global && feedback.text.includes('2時間'),JSON.stringify(feedback));
    check('layout','dialog feedback does not cover reset or close actions',
      overlap(feedback.status,feedback.close)===0 && overlap(feedback.status,feedback.reset)===0,
      JSON.stringify({close:overlap(feedback.status,feedback.close),reset:overlap(feedback.status,feedback.reset)}));
    await page.mouse.move(2,2); await page.mouse.wheel({deltaY:900}); await new Promise(r=>setTimeout(r,40));
    const afterModalWheel = await page.evaluate(() => scrollY);
    check('layout','settings prevents background scrolling',afterModalWheel === modalY,`before=${modalY},after=${afterModalWheel}`);
    await page.click('#setClose');
    await page.click('.tab[data-v="log"]');
    await page.click('#gearBtn'); await page.click('#resetBtn'); await page.click('#resetBtn'); await new Promise(r=>setTimeout(r,80));
    const reset = await page.evaluate(() => ({home:document.querySelector('#view-home').classList.contains('active'),
      onboard:document.querySelector('#onboard').classList.contains('show'),focus:document.activeElement&&document.activeElement.id,
      local:document.querySelector('#onboardStatus').classList.contains('show'),text:document.querySelector('#onboardStatus').textContent,
      global:document.querySelector('#toast').classList.contains('show')}));
    check('accessibility','reset returns to home onboarding with visible in-dialog feedback',
      reset.home&&reset.onboard&&reset.focus==='obStart'&&reset.local&&!reset.global&&reset.text.includes('データをけしたよ'),JSON.stringify(reset));
    check('browser','modal and scroll regression scenario has no browser errors',errors.length===0,errors.join(' | '));
    await context.close();
  }

  // A double-click must advance at most one reward screen.
  {
    const context = await browser.createBrowserContext();
    const { page, errors } = await loadPage(context, origin,
      { width:375, height:812, deviceScaleFactor:1, isMobile:true, hasTouch:true });
    await page.evaluate(() => {
      const s=JSON.parse(localStorage.getItem('nurisan-v1'));
      Object.assign(s,{onboard:true,starter:3,coins:0,coinsTotal:7,total:3,lastAppliedAt:0,nextDueAt:0,lastDate:'',log:{}});
      s.parts={'base-sun':1,'eye-normal':1,'mouth-smile':1,'ray-togari':1};
      s.wear={base:'base-sun',bg:'none',ray:'ray-togari',wear:'none',cheek:'none',eye:'eye-normal',mouth:'mouth-smile',glasses:'none',neck:'none',hat:'none',hand:'none',fx:'none'};
      localStorage.setItem('nurisan-v1',JSON.stringify(s));
    });
    await page.reload({waitUntil:'load'}); await new Promise(r=>setTimeout(r,60));
    await page.evaluate(() => { Math.random=()=>0.5; });
    await page.click('#nuttaBtn'); await new Promise(r=>setTimeout(r,1100));
    await page.click('#gNext',{clickCount:2,delay:10}); await new Promise(r=>setTimeout(r,80));
    const reward = await page.evaluate(() => ({shown:document.querySelector('#gacha').classList.contains('show'),
      name:document.querySelector('#gName').textContent,disabled:document.querySelector('#gNext').disabled,
      queue:eval('gachaQueue.length')}));
    check('ui','double-click cannot skip the unlock reward screen',reward.shown&&reward.name.includes('あたらしいパーツ')&&reward.disabled,JSON.stringify(reward));
    check('browser','reward double-click scenario has no browser errors',errors.length===0,errors.join(' | '));
    await context.close();
  }

  // Simulated iPhone safe-area insets keep content and toast above the tab bar.
  {
    const context = await browser.createBrowserContext();
    const { page } = await loadPage(context, origin,
      { width:375, height:812, deviceScaleFactor:2, isMobile:true, hasTouch:true });
    await page.click('#obStart');
    await page.addStyleTag({content:':root{--safeTop:44px;--safeRight:0px;--safeBottom:34px;--safeLeft:0px}'});
    await page.evaluate(() => { S.coinsTotal=1000; renderAll(); switchTab('dress',true); });
    await new Promise(r=>setTimeout(r,60));
    await page.evaluate(() => scrollTo(0,document.documentElement.scrollHeight)); await new Promise(r=>setTimeout(r,40));
    await page.evaluate(() => toast('safe area test'));
    const safe = await page.evaluate(() => { const h=document.querySelector('header').getBoundingClientRect(); return {header:{...h.toJSON(),documentTop:h.top+scrollY},
      last:document.querySelector('#dressGrid .tile:last-child').getBoundingClientRect().toJSON(),
      tab:document.querySelector('.tabinner').getBoundingClientRect().toJSON(),toast:document.querySelector('#toast').getBoundingClientRect().toJSON()}; });
    check('layout','simulated safe areas keep header below the top inset',safe.header.documentTop>=44,JSON.stringify(safe.header));
    check('layout','simulated safe areas keep the last tile above the tab bar',safe.last.bottom<=safe.tab.top+0.5,JSON.stringify({last:safe.last,tab:safe.tab}));
    check('layout','simulated safe areas keep toast above the tab bar',safe.toast.bottom<=safe.tab.top+0.5,JSON.stringify({toast:safe.toast,tab:safe.tab}));
    await context.close();
  }

  // Force one tab to hold its write so record + setting overlap in a real browser.
  {
    const context = await browser.createBrowserContext();
    const a = await loadPage(context, origin, { width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true });
    await a.page.evaluate(() => localStorage.clear()); await a.page.reload({waitUntil:'load'}); await new Promise(r=>setTimeout(r,50));
    await a.page.click('#obStart'); await new Promise(r=>setTimeout(r,50));
    const b = await loadPage(context, origin, { width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true });
    await a.page.evaluate(() => {
      const original=store.set.bind(store); window.__saveEntered=false; window.__releaseSave=null; window.__delayOnce=true;
      store.set=async(k,v)=>{if(window.__delayOnce){window.__delayOnce=false;window.__saveEntered=true;await new Promise(r=>window.__releaseSave=r);}return original(k,v);};
    });
    const recording = a.page.evaluate(() => onNutta());
    await a.page.waitForFunction(() => window.__saveEntered===true);
    await b.page.click('#gearBtn');
    await b.page.click('#intervalSeg button[data-min="120"]'); await new Promise(r=>setTimeout(r,50));
    await a.page.evaluate(() => window.__releaseSave()); await recording; await new Promise(r=>setTimeout(r,100));
    const saved = await b.page.evaluate(() => JSON.parse(localStorage.getItem('nurisan-v1')));
    check('concurrency','real overlapping record and setting writes both persist',saved.total===1&&saved.intervalMin===120,JSON.stringify({total:saved.total,intervalMin:saved.intervalMin}));
    check('browser','overlapping write scenario has no browser errors',a.errors.length===0&&b.errors.length===0,[...a.errors,...b.errors].join(' | '));
    await context.close();
  }

  // Actual same-origin pages share localStorage and expose stale-tab overwrites.
  {
    const context = await browser.createBrowserContext();
    const a = await loadPage(context, origin, { width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await a.page.evaluate(() => localStorage.clear());
    await a.page.reload({ waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 40));
    await a.page.click('#obStart');
    const b = await loadPage(context, origin, { width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await a.page.evaluate(() => eval('onNutta()'));
    await new Promise(r => setTimeout(r, 30));
    // 30分連打防止の仕様に触れず、古いタブが31分後の正当な記録を失わない条件にする。
    await b.page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('nurisan-v1'));
      s.lastAppliedAt -= 31 * 60000;
      s.nextDueAt = s.lastAppliedAt + s.intervalMin * 60000;
      localStorage.setItem('nurisan-v1', JSON.stringify(s));
    });
    await b.page.evaluate(() => eval('onNutta()'));
    await new Promise(r => setTimeout(r, 30));
    const persisted = await b.page.evaluate(() => JSON.parse(localStorage.getItem('nurisan-v1')));
    check('concurrency', 'two actual same-origin tabs preserve both records', persisted.total === 2,
      JSON.stringify({ total: persisted.total, log: persisted.log }));
    check('browser', 'multi-tab scenario has no browser exceptions', a.errors.length === 0 && b.errors.length === 0,
      [...a.errors, ...b.errors].join(' | '));
    await a.page.evaluate(() => {
      document.querySelector('#resetBtn').click();
      document.querySelector('#resetBtn').click();
    });
    await new Promise(r => setTimeout(r, 80));
    const otherTabReset = await b.page.evaluate(() => ({
      onboard: eval('S.onboard'), liveUvStarted: eval('liveUvStarted'),
      hasTimer: eval('liveUvTimer!=null'), shown: document.querySelector('#onboard').classList.contains('show'),
      inert: document.querySelector('#app').hasAttribute('inert')
    }));
    check('privacy', 'reset propagates to another real tab and stops its location runtime',
      otherTabReset.onboard === false && !otherTabReset.liveUvStarted && !otherTabReset.hasTimer
        && otherTabReset.shown && otherTabReset.inert, JSON.stringify(otherTabReset));
    await context.close();
  }

  // A real localStorage read exception must not replace an unread record with defaults.
  {
    const context = await browser.createBrowserContext();
    const { page, errors } = await loadPage(context, origin,
      {width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true}, () => {
        const state={onboard:true,starter:3,coins:7,coinsTotal:20,intervalMin:180,sound:false,
          lastAppliedAt:0,nextDueAt:0,region:'kanto',regionManual:false,
          parts:{'base-sun':1,'eye-normal':1,'mouth-smile':1,'ray-togari':1},
          wear:{base:'base-sun',bg:'none',ray:'ray-togari',wear:'none',cheek:'none',eye:'eye-normal',mouth:'mouth-smile',glasses:'none',neck:'none',hat:'none',hand:'none',fx:'none'},
          migrated:true,lastDate:'',streak:0,bestStreak:0,total:42,log:{},col:{}};
        localStorage.setItem('nurisan-v1',JSON.stringify(state));
        const nativeGet=Storage.prototype.getItem; let failed=false;
        Storage.prototype.getItem=function(key){
          if(key==='nurisan-v1'&&!failed){failed=true;throw new DOMException('temporary failure','UnknownError');}
          return nativeGet.call(this,key);
        };
      });
    const before = await page.evaluate(() => ({stored:JSON.parse(localStorage.getItem('nurisan-v1')).total,
      memory:eval('S.total'),warning:document.querySelector('#onboardStatus').textContent,
      shown:document.querySelector('#onboardStatus').classList.contains('show')}));
    await page.evaluate(() => onNutta()); await new Promise(r=>setTimeout(r,60));
    const after = await page.evaluate(() => ({stored:JSON.parse(localStorage.getItem('nurisan-v1')).total,
      memory:eval('S.total'),failed:eval('stateReadFailed')}));
    check('persistence','real localStorage read failure preserves data and recovers on the next mutation',
      before.stored===42&&before.memory===0&&before.shown&&before.warning.includes('上書きしない')
        &&after.stored===43&&after.memory===43&&!after.failed&&errors.length===0,
      JSON.stringify({before,after,errors}));
    await context.close();
  }

  // Re-rendering dress controls must keep keyboard focus and announce confirmation/equip actions.
  {
    const context = await browser.createBrowserContext();
    const { page, errors } = await loadPage(context, origin,
      { width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true });
    await page.click('#obStart'); await new Promise(r=>setTimeout(r,50));
    await page.evaluate(() => {
      const s=JSON.parse(localStorage.getItem('nurisan-v1'));
      Object.assign(s,{coins:10,coinsTotal:100,onboard:true});
      localStorage.setItem('nurisan-v1',JSON.stringify(s));
    });
    await page.reload({waitUntil:'load'}); await new Promise(r=>setTimeout(r,60));
    await page.click('.tab[data-v="dress"]');
    await page.focus('#dressGrid [data-id="base-drop"]'); await page.keyboard.press('Enter'); await new Promise(r=>setTimeout(r,80));
    const confirm = await page.evaluate(() => ({tag:document.activeElement&&document.activeElement.tagName,
      id:document.activeElement&&document.activeElement.dataset.id,live:document.querySelector('#toast').textContent,
      shown:document.querySelector('#toast').classList.contains('show')}));
    check('accessibility','purchase confirmation keeps tile focus and announces the second action',
      confirm.tag==='BUTTON'&&confirm.id==='base-drop'&&confirm.shown&&confirm.live.includes('もういちど'),JSON.stringify(confirm));
    await page.focus('#catTabs [data-c="bg"]'); await page.keyboard.press('Enter'); await new Promise(r=>setTimeout(r,60));
    const category = await page.evaluate(() => ({tag:document.activeElement&&document.activeElement.tagName,
      cat:document.activeElement&&document.activeElement.dataset.c}));
    check('accessibility','category activation keeps focus on the recreated category button',
      category.tag==='BUTTON'&&category.cat==='bg',JSON.stringify(category));
    await page.focus('#catTabs [data-c="base"]'); await page.keyboard.press('Enter'); await new Promise(r=>setTimeout(r,50));
    await page.focus('#dressGrid [data-id="base-sun"]'); await page.keyboard.press('Enter'); await new Promise(r=>setTimeout(r,80));
    const equipped = await page.evaluate(() => ({id:document.activeElement&&document.activeElement.dataset.id,
      live:document.querySelector('#toast').textContent,errors:window.__qaErrors||[]}));
    check('accessibility','equipping an owned tile retains focus and has live feedback',
      equipped.id==='base-sun'&&equipped.live.includes('つけたよ')&&errors.length===0,
      JSON.stringify({...equipped,browserErrors:errors}));
    await context.close();
  }

  // A short landscape viewport opens settings at the top while preserving its own scrolling.
  {
    const context = await browser.createBrowserContext();
    const { page } = await loadPage(context, origin,
      { width:667,height:375,deviceScaleFactor:1,isMobile:true,hasTouch:true });
    await page.click('#obStart'); await new Promise(r=>setTimeout(r,50));
    await page.click('#gearBtn'); await new Promise(r=>setTimeout(r,30));
    const before = await page.evaluate(() => {
      const sheet=document.querySelector('#settings .sheet');
      const r=sheet.getBoundingClientRect();
      return {initial:sheet.scrollTop,max:sheet.scrollHeight-sheet.clientHeight,focus:document.activeElement&&document.activeElement.id,
        bodyY:scrollY,bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};
    });
    const client = await page.createCDPSession();
    const xPos=Math.round(before.bounds.x+before.bounds.width/2), startY=Math.round(before.bounds.y+before.bounds.height-25);
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:xPos,y:startY}]});
    for(let i=1;i<=6;i++){
      await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:xPos,y:startY-i*30}]});
      await new Promise(r=>setTimeout(r,20));
    }
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await new Promise(r=>setTimeout(r,80));
    const after = await page.evaluate(() => ({scrollTop:document.querySelector('#settings .sheet').scrollTop,bodyY:scrollY}));
    check('layout','short landscape settings opens at top and remains internally scrollable',
      before.initial===0&&before.max>0&&before.focus==='regionSel'&&after.scrollTop>0&&after.bodyY===before.bodyY,
      JSON.stringify({before,after}));
    await context.close();
  }

  // Missing packaged region boundaries must be visible instead of silently using Kanto.
  {
    const context = await browser.createBrowserContext();
    const { page } = await loadPage(context, origin + 'missing-region.html',
      { width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true });
    const initial = await page.evaluate(() => ({available:eval('regionDataAvailable'),
      shown:document.querySelector('#onboardStatus').classList.contains('show'),
      text:document.querySelector('#onboardStatus').textContent}));
    await page.click('#obStart'); await new Promise(r=>setTimeout(r,60));
    const after = await page.evaluate(() => ({shown:document.querySelector('#banner').classList.contains('show'),
      text:document.querySelector('#bannerText').textContent}));
    check('resilience','missing region-data script warns both before and after onboarding',
      !initial.available&&initial.shown&&initial.text.includes('ちいきデータ')
        &&after.shown&&after.text.includes('せってい'),JSON.stringify({initial,after}));
    await context.close();
  }

  // Clearing data in another tab cancels an unrevealed reward callback and its sound.
  {
    const context = await browser.createBrowserContext();
    const a = await loadPage(context, origin, {width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await a.page.click('#obStart'); await new Promise(r=>setTimeout(r,40));
    const b = await loadPage(context, origin, {width:375,height:812,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await a.page.evaluate(() => {
      window.__audioStarts=0;
      ac={state:'running',currentTime:0,destination:{},resume(){return Promise.resolve();},
        createOscillator(){return {frequency:{value:0},connect(){},start(){window.__audioStarts++;},stop(){}};},
        createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}};
    });
    await a.page.click('#nuttaBtn'); await a.page.waitForSelector('#gacha.show');
    await b.page.evaluate(() => localStorage.clear());
    await new Promise(r=>setTimeout(r,1200));
    const stale = await a.page.evaluate(() => ({onboard:eval('S.onboard'),
      gacha:document.querySelector('#gacha').classList.contains('show'),name:document.querySelector('#gName').textContent,
      starts:window.__audioStarts,revealTimer:eval('gachaRevealTimer')}));
    check('concurrency','cross-tab reset cancels delayed reward DOM and audio work',
      stale.onboard===false&&!stale.gacha&&stale.name===''&&stale.starts===0&&stale.revealTimer===null,JSON.stringify(stale));
    await context.close();
  }

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.group}\t${r.name}\t${r.detail}`);
  console.log(`SUMMARY\t${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (failed.length) process.exitCode = 1;
})().catch(async error => {
  console.error(error);
  try { server.close(); } catch (_) {}
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});
