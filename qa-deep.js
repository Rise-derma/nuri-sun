const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const rawHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const regionData = fs.readFileSync(path.join(__dirname, 'region-data.js'), 'utf8');
const normalHtml = rawHtml.replace('<script src="./region-data.js"></script>', `<script>${regionData}</script>`);
const KEY = 'nurisan-v1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function baseState(now = new Date(2026, 7, 5, 10, 30).getTime()) {
  return {
    onboard: true, starter: 3, coins: 12, coinsTotal: 100, intervalMin: 180, sound: false,
    lastAppliedAt: 0, nextDueAt: 0, region: 'kanto', regionManual: false,
    parts: { 'base-sun': 1, 'eye-normal': 1, 'mouth-smile': 1, 'ray-togari': 1 },
    wear: { base: 'base-sun', bg: 'none', ray: 'ray-togari', wear: 'none', cheek: 'none',
      eye: 'eye-normal', mouth: 'mouth-smile', glasses: 'none', neck: 'none', hat: 'none',
      hand: 'none', fx: 'none' },
    migrated: true, lastDate: '', streak: 0, bestStreak: 0, total: 0, log: {}, col: {},
    _qaNow: now
  };
}

async function boot({ html = normalHtml, state, raw, now, beforeParse, geo, fetchImpl, permissions } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(`jsdom:${error && (error.stack || error)}`));
  vc.on('error', (...args) => errors.push(`console:${args.map(String).join(' ')}`));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://example.test/index.html', virtualConsole: vc,
    beforeParse(window) {
      let clock = now == null ? Date.now() : now;
      if (now != null) {
        const RealDate = window.Date;
        class FakeDate extends RealDate {
          constructor(...args) { super(...(args.length ? args : [clock])); }
          static now() { return clock; }
        }
        window.Date = FakeDate;
        window.__setNow = value => { clock = value; };
      }
      window.setInterval = () => 1;
      window.clearInterval = () => {};
      window.AudioContext = class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        resume() { return Promise.resolve(); }
        createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
        createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {} }, connect() {} }; }
      };
      Object.defineProperty(window.navigator, 'geolocation', { configurable: true,
        value: geo || { getCurrentPosition(_ok, fail) { if (fail) fail(new Error('denied')); } } });
      if (permissions) Object.defineProperty(window.navigator, 'permissions', { configurable: true, value: permissions });
      window.fetch = fetchImpl || (async () => { throw new Error('offline'); });
      if (raw !== undefined) window.localStorage.setItem(KEY, raw);
      else if (state !== undefined) window.localStorage.setItem(KEY, JSON.stringify(state));
      if (beforeParse) beforeParse(window);
    }
  });
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  await wait(35);
  return { dom, w: dom.window, d: dom.window.document, errors };
}

const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: Boolean(ok), detail });
}
async function close(...items) {
  items.forEach(item => item.dom.window.close());
  await wait(2);
}

(async () => {
  // The tiny capability probe can succeed even when the real state write is rejected by quota.
  {
    const x = await boot({ beforeParse(window) {
      const original = window.Storage.prototype.setItem;
      window.Storage.prototype.setItem = function setItem(key, value) {
        if (key === KEY) throw new window.DOMException('quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    } });
    const local = x.d.querySelector('#onboardStatus');
    const global = x.d.querySelector('#banner');
    const visible = (local.classList.contains('show') && local.textContent.includes('ほぞん'))
      || (global.classList.contains('show') && x.d.querySelector('#bannerText').textContent.includes('ほぞん'));
    check('persistence', 'initial full-state write failure remains visible inside onboarding', visible,
      JSON.stringify({ store: x.w.eval('store.kind'), local: local.textContent,
        localShown: local.classList.contains('show'), global: x.d.querySelector('#bannerText').textContent,
        globalShown: global.classList.contains('show') }));
    await close(x);
  }

  // A structurally valid JavaScript assignment with broken nested coordinates must not crash location handling.
  {
    const ids = ['hokkaido','tohoku','kanto','chubu','kinki','chugoku','kyushu','okinawa'];
    const broken = Object.fromEntries(ids.map(id => [id, [[[null, [139, 35], [140, 36]]]]]));
    const script = `<script>window.NURISAN_REGION_SHAPES=${JSON.stringify(broken)}</script>`;
    const html = rawHtml.replace('<script src="./region-data.js"></script>', script);
    const x = await boot({ html, state: baseState() });
    let threw = '';
    try { x.w.eval('regionFromCoords(35.68,139.77)'); } catch (error) { threw = String(error); }
    check('region', 'malformed nested boundary data is rejected without throwing',
      !threw && x.w.eval('regionDataAvailable') === false, threw || `available=${x.w.eval('regionDataAvailable')}`);
    await close(x);
  }

  // Moving the system clock behind the last record must not create a countdown longer than the selected interval.
  {
    const start = new Date(2026, 7, 5, 10, 30).getTime();
    const state = baseState(start);
    state.lastDate = '2026-08-05'; state.streak = 1; state.bestStreak = 1; state.total = 1;
    state.log = { '2026-08-05': 1 };
    state.lastAppliedAt = new Date(2026, 7, 5, 10, 0).getTime();
    state.nextDueAt = new Date(2026, 7, 5, 13, 0).getTime();
    const x = await boot({ state, now: start });
    x.w.__setNow(new Date(2026, 7, 5, 8, 0).getTime());
    x.w.eval('tick()');
    const snapshot = x.w.eval('({home:homeState(), text:document.getElementById("countdown").textContent, remain:S.nextDueAt-Date.now(), max:S.intervalMin*60000})');
    check('time', 'clock rollback never displays an overlong active countdown',
      snapshot.home !== 'active' || snapshot.remain <= snapshot.max, JSON.stringify(snapshot));
    await close(x);
  }

  // A live UV response timestamp in the future (after clock rollback) is stale, not perpetually fresh.
  {
    const start = new Date(2026, 7, 5, 10, 30).getTime();
    const x = await boot({ state: baseState(start), now: start });
    x.w.eval('uvLive=7.2;uvLiveAt=Date.now();renderUV()');
    x.w.__setNow(start - 2 * 60 * 60000);
    x.w.eval('renderUV()');
    const badge = x.d.querySelector('#uvBadge').textContent;
    check('time', 'clock rollback invalidates future-dated live UV cache', badge === 'ちいきべつ', badge);
    await close(x);
  }

  // Permissions API changes should cause one immediate retry and remove the old listener on reset.
  {
    let geoCalls = 0;
    const listeners = new Set();
    const status = { state: 'prompt', addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
      removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); } };
    const permissions = { query: async () => status };
    const geo = { getCurrentPosition(ok) { geoCalls++; ok({ coords: { latitude: 35.68, longitude: 139.77 } }); } };
    const x = await boot({ state: baseState(), permissions, geo,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ current: { uv_index: 4.5 } }) }) });
    await wait(20);
    const before = geoCalls;
    status.state = 'denied'; [...listeners].forEach(fn => fn());
    status.state = 'granted'; [...listeners].forEach(fn => fn());
    await wait(20);
    x.w.eval('stopLiveUVUpdates()');
    check('privacy', 'permission denied-to-granted transition retries once and listener is removed',
      before === 1 && geoCalls === 2 && listeners.size === 0,
      JSON.stringify({ before, after: geoCalls, listeners: listeners.size }));
    await close(x);
  }

  // Various malformed Open-Meteo fallbacks must reject cleanly rather than produce NaN or throw outside the promise.
  {
    const cases = [
      { hourly: { uv_index: [5], time: 'not-an-array' } },
      { hourly: { uv_index: [5], time: [null] } },
      { current: { uv_index: Number.NaN } },
      { current: { uv_index: 4 }, hourly: { uv_index: [], time: [] } }
    ];
    let clean = 0;
    for (const payload of cases) {
      const x = await boot({ state: baseState(), fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) });
      try {
        const value = await x.w.eval('fetchUV(35.68,139.77)');
        if (Number.isFinite(value)) clean++;
      } catch (error) { clean++; }
      await close(x);
    }
    check('network', 'malformed UV payloads settle cleanly', clean === cases.length, `${clean}/${cases.length}`);
  }

  // Top-level __proto__ data from JSON must not alter the state object's prototype.
  {
    const state = baseState();
    const raw = JSON.stringify(state).replace(/}$/, ',"__proto__":{"polluted":true}}');
    const x = await boot({ raw });
    const polluted = x.w.eval('S.polluted===true || Object.getPrototypeOf(S)!==Object.prototype');
    check('storage', 'JSON __proto__ cannot change the state object prototype', !polluted, `polluted=${polluted}`);
    await close(x);
  }

  // A no-op action still needs to persist sanitation of data written by an older/other tab.
  {
    const x = await boot({ state: baseState() });
    const tainted = JSON.stringify(baseState()).replace(/}$/, ',"unexpected":"drop-me","__proto__":{"polluted":true}}');
    x.w.localStorage.setItem(KEY, tainted);
    await x.w.eval('mutateState(()=>({changed:false}))');
    const savedRaw = x.w.localStorage.getItem(KEY);
    const saved = JSON.parse(savedRaw);
    check('storage', 'no-op mutation permanently sanitizes a tainted cross-tab state',
      !Object.prototype.hasOwnProperty.call(saved, 'unexpected')
        && !Object.prototype.hasOwnProperty.call(saved, '__proto__')
        && x.w.eval('Object.getPrototypeOf(S)===Object.prototype'),
      JSON.stringify({ unexpected: saved.unexpected, proto: Object.prototype.hasOwnProperty.call(saved, '__proto__'),
        cleanPrototype: x.w.eval('Object.getPrototypeOf(S)===Object.prototype') }));
    await close(x);
  }

  // A read failure during an in-session refresh must be visible before the user confirms an action.
  {
    const x = await boot({ state: baseState() });
    x.w.eval('store.__qaGet=store.get;store.get=async()=>{throw new Error("forced refresh read failure")}');
    const ok = await x.w.eval('syncLatestState()');
    const warning = x.w.eval('({failed:stateReadFailed,shown:document.getElementById("banner").classList.contains("show"),text:document.getElementById("bannerText").textContent})');
    check('persistence', 'mid-session refresh read failure is reported immediately',
      ok === false && warning.failed && warning.shown && warning.text.includes('よみこめなかった'),
      JSON.stringify({ ok, warning }));
    await close(x);
  }

  // Calendar arithmetic must also survive the 25-hour daylight-saving fall-back day.
  {
    const previousTZ = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const now = new Date(2025, 10, 3, 9).getTime();
      const x = await boot({ state: baseState(now), now });
      const dates = x.w.eval('({yesterday:ds(calendarDayOffset(-1)),tomorrow:ds(calendarDayOffset(1))})');
      check('time', 'DST fall-back keeps adjacent calendar dates correct',
        dates.yesterday === '2025-11-02' && dates.tomorrow === '2025-11-04', JSON.stringify(dates));
      await close(x);
    } finally {
      if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
    }
  }

  // Three concurrent mutations behind Web Locks retain all independent changes.
  {
    const shared = new Map([[KEY, JSON.stringify(baseState())]]);
    let tail = Promise.resolve();
    const locks = { request(_name, _options, callback) { const next = tail.then(callback); tail = next.catch(() => {}); return next; } };
    const html = normalHtml;
    async function sharedBoot() {
      return boot({ html, beforeParse(window) {
        Object.defineProperty(window.navigator, 'locks', { configurable: true, value: locks });
        window.storage = { async get(key) { await wait(8); return shared.has(key) ? { value: shared.get(key) } : null; },
          async set(key, value) { await wait(8); shared.set(key, value); }, async delete(key) { shared.delete(key); } };
      } });
    }
    const [a, b, c] = await Promise.all([sharedBoot(), sharedBoot(), sharedBoot()]);
    const p1 = a.w.eval('mutateState(()=>{S.coins+=1;return {changed:true}})');
    const p2 = b.w.eval('mutateState(()=>{S.intervalMin=120;return {changed:true}})');
    const p3 = c.w.eval('mutateState(()=>{S.region="chubu";S.regionManual=true;return {changed:true}})');
    await Promise.all([p1, p2, p3]);
    const saved = JSON.parse(shared.get(KEY));
    check('concurrency', 'three serialized independent mutations are all preserved',
      saved.coins === 13 && saved.intervalMin === 120 && saved.region === 'chubu' && saved.regionManual,
      JSON.stringify({ coins: saved.coins, intervalMin: saved.intervalMin, region: saved.region,
        regionManual: saved.regionManual }));
    await close(a, b, c);
  }

  const failed = results.filter(result => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}\t${result.group}\t${result.name}\t${result.detail}`);
  }
  console.log(`SUMMARY\t${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (failed.length) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
