const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const bundledHtml = fs.existsSync(path.join(__dirname, 'nuri-sun-web.html')) ? 'nuri-sun-web.html' : 'index.html';
const htmlPath = process.env.NURISAN_HTML || path.join(__dirname, bundledHtml);
const rawHtml = fs.readFileSync(htmlPath, 'utf8');
const regionData = fs.readFileSync(path.join(path.dirname(htmlPath), 'region-data.js'), 'utf8');
const html = rawHtml.replace('<script src="./region-data.js"></script>', `<script>${regionData}</script>`);
const KEY = 'nurisan-v1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

let rejectionSink = null;
process.on('unhandledRejection', reason => {
  if (rejectionSink) rejectionSink.push(`unhandledRejection: ${reason && (reason.stack || reason)}`);
});

function baseState() {
  return {
    onboard: true,
    starter: 3,
    coins: 0,
    coinsTotal: 0,
    intervalMin: 180,
    sound: false,
    lastAppliedAt: 0,
    nextDueAt: 0,
    region: 'kanto',
    regionManual: false,
    parts: { 'base-sun': 1, 'eye-normal': 1, 'mouth-smile': 1, 'ray-togari': 1 },
    wear: {
      base: 'base-sun', bg: 'none', ray: 'ray-togari', wear: 'none', cheek: 'none',
      eye: 'eye-normal', mouth: 'mouth-smile', glasses: 'none', neck: 'none',
      hat: 'none', hand: 'none', fx: 'none'
    },
    migrated: true,
    lastDate: '',
    streak: 0,
    bestStreak: 0,
    total: 0,
    log: {},
    col: {}
  };
}

async function boot({ state, raw, now, geo, fetchImpl, audioMode = 'running', shared } = {}) {
  const errors = [];
  rejectionSink = errors;
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(`jsdom: ${e && (e.stack || e)}`));
  vc.on('error', (...a) => errors.push(`console: ${a.map(String).join(' ')}`));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/index.html',
    virtualConsole: vc,
    beforeParse(w) {
      let clock = now == null ? Date.now() : now;
      if (now != null) {
        const RealDate = w.Date;
        class FakeDate extends RealDate {
          constructor(...args) { super(...(args.length ? args : [clock])); }
          static now() { return clock; }
        }
        w.Date = FakeDate;
        w.__setNow = value => { clock = value; };
      }

      w.__intervals = [];
      w.setInterval = (fn, ms) => {
        const item = { fn, ms, active: true };
        w.__intervals.push(item);
        return w.__intervals.length;
      };
      w.clearInterval = id => {
        if (w.__intervals[id - 1]) w.__intervals[id - 1].active = false;
      };

      w.__oscStarts = 0;
      w.AudioContext = class {
        constructor() {
          this.state = audioMode === 'running' ? 'running' : 'suspended';
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {
          if (audioMode === 'reject') return Promise.reject(new Error('resume blocked'));
          if (audioMode === 'delayed') {
            return new Promise(resolve => setTimeout(() => { this.state = 'running'; resolve(); }, 50));
          }
          this.state = 'running';
          return Promise.resolve();
        }
        createOscillator() {
          return {
            type: '', frequency: { value: 0 }, connect() {},
            start: () => { w.__oscStarts++; }, stop() {}
          };
        }
        createGain() {
          return {
            gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {}
          };
        }
      };

      Object.defineProperty(w.navigator, 'geolocation', {
        configurable: true,
        value: geo || { getCurrentPosition(_ok, fail) { if (fail) fail(new Error('denied')); } }
      });
      w.fetch = fetchImpl || (async () => { throw new Error('offline'); });

      if (shared) {
        w.storage = {
          async get(k) { return shared.has(k) ? { value: shared.get(k) } : null; },
          async set(k, value) { shared.set(k, value); }
        };
        if (raw !== undefined) shared.set(KEY, raw);
        else if (state !== undefined) shared.set(KEY, JSON.stringify(state));
      } else if (raw !== undefined) {
        w.localStorage.setItem(KEY, raw);
      } else if (state !== undefined) {
        w.localStorage.setItem(KEY, JSON.stringify(state));
      }
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  await wait(12);
  return { dom, w: dom.window, d: dom.window.document, errors };
}

const getState = w => w.eval('S');
let closedWindows = 0;
const close = async x => {
  x.dom.window.close();
  closedWindows++;
  if (global.gc && closedWindows % 25 === 0) global.gc();
  await wait(1);
};

const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: Boolean(ok), detail });
}

let fuzzSeed = 0x4e555249;
function fuzzRandom() {
  fuzzSeed = (Math.imul(fuzzSeed, 1664525) + 1013904223) >>> 0;
  return fuzzSeed / 0x100000000;
}
function randomScalar() {
  const pool = [null, true, false, 0, -1, 1, 1.9, 1e20, '', '0', '-8', 'false', 'x', [], {}, [1, 2]];
  return pool[Math.floor(fuzzRandom() * pool.length)];
}

function contrast(a, b) {
  const lum = hex => {
    const c = hex.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

(async () => {
  // JSON primitives and malformed JSON must never prevent startup.
  for (const raw of ['null', 'true', '17', '"abc"', '[]', '{}', '{bad json']) {
    const x = await boot({ raw });
    const s = getState(x.w);
    check('storage', `boot from ${raw}`, x.errors.length === 0 && s && s.parts['base-sun'] === 1, x.errors[0] || 'ok');
    await close(x);
  }

  // Random JSON-compatible corrupt states: 100 independent boots.
  let fuzzFailures = 0;
  let firstFuzz = '';
  for (let i = 0; i < 100; i++) {
    const candidate = {};
    for (const k of ['onboard', 'starter', 'coins', 'coinsTotal', 'intervalMin', 'sound',
      'lastAppliedAt', 'nextDueAt', 'region', 'regionManual', 'parts', 'wear', 'migrated',
      'lastDate', 'streak', 'bestStreak', 'total', 'log', 'col', 'avatar']) {
      if (fuzzRandom() < 0.8) candidate[k] = randomScalar();
    }
    if (fuzzRandom() < 0.5) candidate.parts = {
      'base-sun': randomScalar(), 'bg-sky': randomScalar(), '<img src=x onerror=1>': 1
    };
    if (fuzzRandom() < 0.5) candidate.log = {
      '2026-02-29': randomScalar(), '2028-02-29': randomScalar(), '__proto__': randomScalar()
    };
    const x = await boot({ state: candidate });
    const s = getState(x.w);
    const ids = new Set(x.w.eval('PARTS.map(p => p.id)'));
    const cats = x.w.eval('CATS.map(c => c.id)');
    const invariant = x.errors.length === 0 && s && typeof s === 'object' && !Array.isArray(s)
      && s.parts && typeof s.parts === 'object' && !Array.isArray(s.parts)
      && s.log && typeof s.log === 'object' && !Array.isArray(s.log)
      && s.wear && typeof s.wear === 'object' && !Array.isArray(s.wear)
      && s.parts['base-sun'] >= 1
      && Object.keys(s.parts).every(id => ids.has(id) && Number.isFinite(s.parts[id]) && s.parts[id] >= 1)
      && Object.keys(s.log).every(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && s.log[k] >= 1 && s.log[k] <= 99)
      && ['hokkaido', 'tohoku', 'kanto', 'chubu', 'kinki', 'chugoku', 'kyushu', 'okinawa'].includes(s.region)
      && [120, 150, 180].includes(s.intervalMin)
      && cats.every(cat => typeof s.wear[cat] === 'string');
    if (!invariant) {
      fuzzFailures++;
      if (!firstFuzz) firstFuzz = JSON.stringify({ candidate, errors: x.errors, state: s });
    }
    await close(x);
  }
  check('storage', '100 corrupt-state fuzz boots preserve structural invariants', fuzzFailures === 0,
    fuzzFailures ? `${fuzzFailures} failures; first=${firstFuzz}` : '100/100');

  // Semantic repair checks not covered by structural invariants.
  {
    const s = baseState();
    s.parts['bg-sky'] = 0;
    const x = await boot({ state: s });
    check('storage', 'zero-count part stays unowned', !getState(x.w).parts['bg-sky'], JSON.stringify(getState(x.w).parts));
    await close(x);
  }
  {
    const now = new Date(2026, 7, 4, 10).getTime();
    const s = baseState();
    s.lastDate = '2099-12-31'; s.log = { '2099-12-31': 4 }; s.streak = 99; s.bestStreak = 99;
    const x = await boot({ state: s, now });
    check('storage', 'future streak date and log entry are discarded', getState(x.w).lastDate === ''
      && !getState(x.w).log['2099-12-31'], JSON.stringify({ lastDate:getState(x.w).lastDate, log:getState(x.w).log }));
    await close(x);
  }
  for (const minutes of [120, 150]) {
    const now = new Date(2026, 7, 4, 10).getTime();
    const s = baseState();
    Object.assign(s, { intervalMin: minutes, lastAppliedAt: now, nextDueAt: now + minutes * 60000 });
    const x = await boot({ state: s, now });
    const persisted = JSON.parse(x.w.localStorage.getItem(KEY));
    check('storage', `${minutes}-minute setting survives normalization and reload`,
      getState(x.w).intervalMin === minutes && persisted.intervalMin === minutes
        && getState(x.w).nextDueAt === now + minutes * 60000,
      JSON.stringify({ interval: getState(x.w).intervalMin, saved: persisted.intervalMin,
        dueMinutes: (getState(x.w).nextDueAt - now) / 60000 }));
    await close(x);
  }
  {
    const now = new Date(2026, 7, 4, 10).getTime();
    const s = baseState();
    Object.assign(s, { intervalMin: 120, lastAppliedAt: now, nextDueAt: now + 180 * 60000 });
    const x = await boot({ state: s, now });
    check('storage', 'countdown beyond selected interval is cleared', getState(x.w).nextDueAt === 0,
      `nextDueAt=${getState(x.w).nextDueAt}`);
    await close(x);
  }

  // Calendar transitions including leap day and year boundary.
  for (const [name, prev, now] of [
    ['leap day', new Date(2028, 1, 28, 9).getTime(), new Date(2028, 1, 29, 9).getTime()],
    ['month boundary', new Date(2026, 7, 31, 9).getTime(), new Date(2026, 8, 1, 9).getTime()],
    ['year boundary', new Date(2026, 11, 31, 9).getTime(), new Date(2027, 0, 1, 9).getTime()]
  ]) {
    const s = baseState();
    Object.assign(s, { lastDate: dayKey(prev), streak: 4, bestStreak: 4, total: 4,
      log: { [dayKey(prev)]: 1 }, lastAppliedAt: prev, nextDueAt: 0 });
    const x = await boot({ state: s, now });
    await x.w.eval('onNutta()');
    check('time', `${name} continues streak`, getState(x.w).streak === 5 && getState(x.w).log[dayKey(now)] === 1,
      JSON.stringify({ streak: getState(x.w).streak, log: getState(x.w).log }));
    await close(x);
  }

  // All configured streak rewards should be granted once and survive another record.
  {
    const probe = await boot();
    const bonuses = probe.w.eval('PARTS.filter(p => p.bonus).map(p => ({id:p.id,bonus:p.bonus}))');
    await close(probe);
    for (const b of bonuses) {
      const now = new Date(2026, 7, 4, 9).getTime();
      const prev = now - 86400000;
      const s = baseState();
      Object.assign(s, { lastDate: dayKey(prev), streak: b.bonus - 1, bestStreak: b.bonus - 1,
        total: b.bonus - 1, log: { [dayKey(prev)]: 1 }, lastAppliedAt: prev });
      const x = await boot({ state: s, now });
      await x.w.eval('onNutta()');
      const firstCount = getState(x.w).parts[b.id];
      x.w.__setNow(now + 31 * 60000);
      await x.w.eval('onNutta()');
      check('rewards', `${b.bonus}-day reward ${b.id} is granted once`, firstCount === 1 && getState(x.w).parts[b.id] === 1,
        `first=${firstCount}, second=${getState(x.w).parts[b.id]}`);
      await close(x);
    }
  }

  // Reset must end the current location session and re-consent must fetch fresh data.
  {
    let geoCalls = 0;
    let latitude = 35.68;
    const geo = { getCurrentPosition(ok) { geoCalls++; ok({ coords: { latitude, longitude: 139.77 } }); } };
    const fetchImpl = async url => ({ ok: true, status: 200, json: async () => ({ current: { uv_index: String(url).includes('35.68') ? 6 : 2 } }) });
    const x = await boot({ state: baseState(), geo, fetchImpl });
    await wait(20);
    x.d.querySelector('#resetBtn').click();
    x.d.querySelector('#resetBtn').click();
    await wait(20);
    const runtime = x.w.eval('({liveUvStarted,hasTimer:liveUvTimer!=null,lastPos,uvLive,onboard:S.onboard})');
    check('privacy', 'data reset stops live location runtime', !runtime.liveUvStarted && !runtime.hasTimer && runtime.lastPos === null && runtime.uvLive === null,
      JSON.stringify(runtime));
    latitude = 34.98;
    x.d.querySelector('#obStart').click();
    await wait(20);
    check('privacy', 're-consent requests a fresh position immediately', geoCalls === 2, `geoCalls=${geoCalls}`);
    await close(x);
  }
  {
    let pendingSuccess = null;
    let fetchCalls = 0;
    const geo = { getCurrentPosition(ok) { pendingSuccess = ok; } };
    const x = await boot({ state: baseState(), geo,
      fetchImpl: async () => { fetchCalls++; return { ok: true, json: async () => ({ current: { uv_index: 5 } }) }; } });
    x.d.querySelector('#resetBtn').click();
    x.d.querySelector('#resetBtn').click();
    await wait(10);
    pendingSuccess({ coords: { latitude: 35.68, longitude: 139.77 } });
    await wait(20);
    const runtime = x.w.eval('({lastPos,uvLive,liveUvStarted})');
    check('privacy', 'late location callback from a reset session is ignored',
      fetchCalls === 0 && runtime.lastPos === null && runtime.uvLive === null && runtime.liveUvStarted === false,
      JSON.stringify({ fetchCalls, runtime }));
    await close(x);
  }

  // Invalid coordinates must never be transmitted; manual region must not be overwritten.
  for (const coords of [[NaN, 139], [91, 139], [-91, 139], [35, 181], [35, -181]]) {
    let fetchCalls = 0;
    const geo = { getCurrentPosition(ok) { ok({ coords: { latitude: coords[0], longitude: coords[1] } }); } };
    const x = await boot({ state: baseState(), geo, fetchImpl: async () => { fetchCalls++; return { ok: true, json: async () => ({ current: { uv_index: 1 } }) }; } });
    await wait(10);
    check('network', `invalid coordinate ${coords} is not sent`, fetchCalls === 0, `fetchCalls=${fetchCalls}`);
    await close(x);
  }
  {
    const s = baseState(); s.region = 'kyushu'; s.regionManual = true;
    const geo = { getCurrentPosition(ok) { ok({ coords: { latitude: 43.06, longitude: 141.35 } }); } };
    const x = await boot({ state: s, geo, fetchImpl: async () => ({ ok: true, json: async () => ({ current: { uv_index: 1 } }) }) });
    await wait(15);
    check('network', 'manual region survives geolocation', getState(x.w).region === 'kyushu', `region=${getState(x.w).region}`);
    check('network', 'live-update scheduler starts only once', x.w.__intervals.filter(i => i.ms === 30 * 60000).length === 1,
      JSON.stringify(x.w.__intervals.map(i => i.ms)));
    x.w.eval('startLiveUVUpdates();startLiveUVUpdates()');
    check('network', 'repeated start does not add polling timers', x.w.__intervals.filter(i => i.ms === 30 * 60000).length === 1,
      JSON.stringify(x.w.__intervals.map(i => i.ms)));
    await close(x);
  }

  // Administrative-region edge cases missed by prefectural-capital checks.
  {
    const x = await boot();
    const places = [
      ['大間', 41.526, 140.907, 'tohoku'], ['上野村', 36.083, 138.777, 'kanto'],
      ['小浜', 35.495, 135.746, 'chubu'], ['門司', 33.944, 130.961, 'kyushu'],
      ['八丈島', 33.113, 139.785, 'kanto'], ['小笠原', 27.094, 142.192, 'kanto']
    ];
    const bad = places.filter(([, lat, lon, want]) => x.w.eval(`regionFromCoords(${lat},${lon})`) !== want)
      .map(([name, lat, lon, want]) => `${name}:${x.w.eval(`regionFromCoords(${lat},${lon})`)}!=${want}`);
    check('region', 'six administrative boundary/island regressions stay fixed', bad.length === 0, bad.join(';') || '6/6');
    await close(x);
  }

  // API payload and fallback behavior.
  const apiCases = [
    ['string UV', { current: { uv_index: '6.2' } }],
    ['null UV', { current: { uv_index: null } }],
    ['infinite UV', { current: { uv_index: Infinity } }],
    ['missing UV', {}]
  ];
  for (const [name, payload] of apiCases) {
    const x = await boot({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) });
    let rejected = false;
    try { await x.w.eval('fetchUV(35,139)'); } catch (_) { rejected = true; }
    check('network', `${name} is rejected`, rejected, `rejected=${rejected}`);
    await close(x);
  }
  {
    const now = new Date(2026, 7, 4, 10, 20).getTime();
    const payload = { hourly: { time: ['2026-08-04T10:00'], uv_index: [7.14] } };
    const x = await boot({ now, fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) });
    check('network', 'hourly API fallback selects current hour and rounds', await x.w.eval('fetchUV(35,139)') === 7.1);
    await close(x);
  }
  {
    const now = new Date(2026, 7, 4, 10).getTime();
    const x = await boot({ now });
    x.w.eval(`uvLive=8.2;uvLiveAt=${now - 3600001};renderUV()`);
    check('network', 'live UV older than one hour falls back to regional estimate', x.d.querySelector('#uvBadge').textContent === 'ちいきべつ',
      x.d.querySelector('#uvBadge').textContent);
    await close(x);
  }

  // Audio resume rejection should not become an unhandled error or count as an audible alert.
  {
    const now = new Date(2026, 7, 4, 10).getTime();
    const s = baseState();
    Object.assign(s, { sound: true, lastDate: dayKey(now), streak: 1, log: { [dayKey(now)]: 1 },
      lastAppliedAt: now - 3 * 3600000, nextDueAt: now - 1000 });
    const x = await boot({ state: s, now, audioMode: 'reject' });
    x.d.body.dispatchEvent(new x.w.Event('pointerdown', { bubbles: true }));
    await wait(20);
    x.w.eval('tick()');
    await wait(10);
    const a = x.w.eval('({dueChimes,acState:ac&&ac.state,starts:window.__oscStarts})');
    check('audio', 'rejected AudioContext resume is handled', x.errors.length === 0, x.errors[0] || 'ok');
    check('audio', 'suspended AudioContext is not counted as an audible reminder', a.dueChimes === 0, JSON.stringify(a));
    await close(x);
  }

  // Interaction and rendering sweep.
  {
    const s = baseState();
    s.coins = 1000; s.coinsTotal = 1000;
    const x = await boot({ state: s });
    for (const v of ['home', 'dress', 'zukan', 'log']) {
      x.d.querySelector(`.tab[data-v="${v}"]`).click();
      check('ui', `tab ${v} activates exactly one view`, x.d.querySelectorAll('.view.active').length === 1 && x.d.querySelector(`#view-${v}`).classList.contains('active'));
    }
    for (let i = 0; i < 100; i++) await x.w.eval("document.getElementById('dressRandom').click()") || wait(0);
    await wait(20);
    const outfitValid = x.w.eval(`CATS.every(c=>{
      const id=S.wear[c.id]; if(c.id!=='base'&&id==='none')return true;
      const p=partById(id); return !!(p&&p.cat===c.id&&S.parts[id]);
    })`);
    check('ui', '100 random outfits never equip an unowned/wrong-category part', outfitValid, JSON.stringify(getState(x.w).wear));
    const svgs = x.w.eval("['m-morning','m-active','m-due','m-night'].map(avatarSVG)");
    check('ui', 'all mascot states render finite SVG', svgs.every(v => v.startsWith('<svg') && !/undefined|NaN|null/.test(v)));
    x.d.querySelector('#gearBtn').click();
    x.d.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('ui', 'Escape closes settings', !x.d.querySelector('#settings').classList.contains('show') && x.d.activeElement === x.d.querySelector('#gearBtn'));
    await close(x);
  }

  // Reward dialog should own focus when it is visible.
  {
    const now = new Date(2026, 7, 4, 9).getTime();
    const x = await boot({ state: baseState(), now });
    x.d.querySelector('#nuttaBtn').focus();
    x.d.querySelector('#nuttaBtn').click();
    await wait(1250);
    check('accessibility', 'visible reward dialog moves focus inside itself', x.d.querySelector('#gacha').contains(x.d.activeElement),
      `activeElement=${x.d.activeElement && (x.d.activeElement.id || x.d.activeElement.tagName)}`);
    check('accessibility', 'visible reward dialog makes background inert', x.d.querySelector('#app').hasAttribute('inert')
      && x.d.querySelector('#app').getAttribute('aria-hidden') === 'true');
    x.d.querySelector('#gNext').click(); await wait(5);
    check('accessibility', 'closing reward restores background interaction', !x.d.querySelector('#app').hasAttribute('inert')
      && !x.d.querySelector('#app').hasAttribute('aria-hidden'));
    await close(x);
  }

  {
    const x = await boot();
    check('accessibility', 'onboarding isolates background content', x.d.querySelector('#app').hasAttribute('inert'));
    x.d.querySelector('#obStart').click(); await wait(10);
    check('accessibility', 'closing onboarding restores background content', !x.d.querySelector('#app').hasAttribute('inert'));
    x.d.querySelector('#gearBtn').click();
    check('accessibility', 'settings dialog isolates background content', x.d.querySelector('#app').hasAttribute('inert'));
    x.d.querySelector('#setClose').click();
    check('accessibility', 'closing settings restores background content', !x.d.querySelector('#app').hasAttribute('inert'));
    await close(x);
  }

  // Multiple open instances should not overwrite each other's records.
  {
    const shared = new Map([[KEY, JSON.stringify(baseState())]]);
    const now = new Date(2026, 7, 4, 9).getTime();
    const a = await boot({ shared, now });
    const b = await boot({ shared, now });
    await a.w.eval('onNutta()');
    b.w.__setNow(now + 31 * 60000);
    await b.w.eval('onNutta()');
    const persisted = JSON.parse(shared.get(KEY));
    check('concurrency', 'two open instances do not lose a record', persisted.total === 2 && persisted.log[dayKey(now)] === 2,
      JSON.stringify({ total: persisted.total, log: persisted.log }));
    await close(a); await close(b);
  }
  {
    const shared = new Map([[KEY, JSON.stringify(baseState())]]);
    const a = await boot({ shared });
    const b = await boot({ shared });
    a.d.querySelector('#resetBtn').click(); a.d.querySelector('#resetBtn').click();
    await wait(15);
    b.w.dispatchEvent(new b.w.StorageEvent('storage', { key: KEY, newValue: shared.get(KEY) }));
    await wait(15);
    const runtime = b.w.eval('({onboard:S.onboard,liveUvStarted,hasTimer:liveUvTimer!=null,lastPos,uvLive})');
    check('concurrency', 'reset in another tab stops location and returns this tab to onboarding',
      runtime.onboard === false && runtime.liveUvStarted === false && runtime.hasTimer === false
        && runtime.lastPos === null && runtime.uvLive === null
        && b.d.querySelector('#onboard').classList.contains('show') && b.d.querySelector('#app').hasAttribute('inert'),
      JSON.stringify(runtime));
    await close(a); await close(b);
  }

  // Markup/security checks independent of app state.
  {
    const d = new JSDOM(html).window.document;
    const rawDocument = new JSDOM(rawHtml).window.document;
    const executableScripts = [...rawDocument.querySelectorAll('script[src]')];
    const remoteScripts = executableScripts.filter(s => /^https?:/i.test(s.getAttribute('src') || ''));
    check('security', 'no remote executable scripts', remoteScripts.length === 0, remoteScripts.map(x => x.src).join(','));
    check('security', 'only the packaged region data script is referenced',
      executableScripts.length === 1 && executableScripts[0].getAttribute('src') === './region-data.js',
      executableScripts.map(x => x.getAttribute('src')).join(','));
    const badLinks = [...d.querySelectorAll('a[href]')].filter(a => !a.href.startsWith('https://'));
    check('security', 'all outbound links use HTTPS', badLinks.length === 0, badLinks.map(a => a.href).join(','));
    const unsafeBlank = [...d.querySelectorAll('a[target="_blank"]')].filter(a => !(a.rel || '').split(/\s+/).includes('noopener'));
    check('security', 'new-tab links prevent opener access', unsafeBlank.length === 0, unsafeBlank.map(a => a.href).join(','));
    const buttonWithoutType = [...d.querySelectorAll('button')].filter(b => !b.hasAttribute('type'));
    check('markup', 'static buttons declare type', buttonWithoutType.length === 0, buttonWithoutType.map(b => b.id).join(','));
    const labelRefs = [...d.querySelectorAll('label[for]')].filter(l => !d.getElementById(l.htmlFor));
    check('markup', 'label references resolve', labelRefs.length === 0, labelRefs.map(l => l.htmlFor).join(','));
    const ariaRefs = [...d.querySelectorAll('[aria-labelledby]')].filter(e => !d.getElementById(e.getAttribute('aria-labelledby')));
    check('markup', 'aria-labelledby references resolve', ariaRefs.length === 0, ariaRefs.map(e => e.id).join(','));
    check('accessibility', 'main mascot exposes valid image semantics', d.querySelector('#mascot').getAttribute('role') === 'img'
      && !!d.querySelector('#mascot').getAttribute('aria-label'),
      d.querySelector('#mascot').outerHTML.slice(0, 100));
    const reduced = html.match(/@media \(prefers-reduced-motion: reduce\)\{([\s\S]*?)\n\}/);
    check('accessibility', 'reduced-motion mode disables confetti and modal/reward animation',
      !!reduced && /confetti/.test(reduced[1]) && /(sheet|g-item)/.test(reduced[1]), reduced ? reduced[1].trim() : 'missing');
    const cssVar = name => (html.match(new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`)) || [])[1];
    const ratios = {
      sub: contrast(cssVar('sub'), '#FFFFFF'),
      inactiveTab: contrast('#647493', '#FFFFFF'),
      accentOnWhite: contrast(cssVar('accentText'), '#FFFFFF'),
      activeTab: contrast(cssVar('accentText'), '#FFF4DC'),
      regionalBadge: contrast('#566786', '#E3ECF7'),
      liveBadge: contrast('#116B3C', '#DFF5E6'),
      buttonOnSun: contrast(cssVar('ink'), cssVar('sun')),
      buttonOnSun2: contrast(cssVar('ink'), cssVar('sun2')),
      rewardBadge: contrast('#FFFFFF', '#B62F3C'),
      nightLogo: contrast('#FFFFFF', '#35406B'),
      uvWeak: contrast('#245B36', '#FFFFFF'),
      uvOrdinary: contrast('#765100', '#FFFFFF'),
      uvStrong: contrast('#873900', '#FFFFFF'),
      uvVeryStrong: contrast('#9B2431', '#FFFFFF'),
      uvExtreme: contrast('#66328A', '#FFFFFF'),
      resetNormal: contrast('#A51D2D', '#FFECEC'),
      resetArmed: contrast('#FFFFFF', '#A51D2D'),
      purchaseConfirm: contrast('#FFFFFF', '#A51D2D')
    };
    check('accessibility', 'small-text palette reaches WCAG AA 4.5:1', Object.values(ratios).every(v => v >= 4.5), JSON.stringify(ratios));
  }

  {
    const x = await boot();
    const approved = 'ローションなら、顔に500円玉1つ分か1円玉2つ分がめやす。少なすぎるとパッケージどおりの力が出にくいよ。';
    check('content', 'approved sunscreen amount wording stays exact', x.w.eval('TIPS[0].t') === approved,
      x.w.eval('TIPS[0].t'));
    await close(x);
  }

  // Corrupt local data must not create HTML/script injection.
  {
    const s = baseState();
    s.region = '<img src=x onerror="window.pwned=1">';
    s.coins = '<svg onload="window.pwned=1">';
    s.parts['<img src=x onerror="window.pwned=1">'] = 1;
    const x = await boot({ state: s });
    check('security', 'corrupt storage cannot inject executable markup', !x.w.pwned && !x.d.querySelector('img[src="x"]'),
      `pwned=${x.w.pwned}`);
    await close(x);
  }

  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}\t${r.group}\t${r.name}\t${r.detail}`);
  }
  console.log(`SUMMARY\t${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (failed.length) process.exitCode = 1;
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
