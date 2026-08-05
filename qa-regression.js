const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const bundledHtml = fs.existsSync(path.join(__dirname, 'nuri-sun-web.html')) ? 'nuri-sun-web.html' : 'index.html';
const htmlPath = process.env.NURISAN_HTML || path.join(__dirname, bundledHtml);
const rawHtml = fs.readFileSync(htmlPath, 'utf8');
const regionData = fs.readFileSync(path.join(path.dirname(htmlPath), 'region-data.js'), 'utf8');
const html = rawHtml.replace('<script src="./region-data.js"></script>', `<script>${regionData}</script>`);
const regionSamples = JSON.parse(fs.readFileSync(path.join(__dirname, 'region-samples.json'), 'utf8'));
const KEY = 'nurisan-v1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function baseState(){
  return {
    onboard:true, starter:3, coins:10, coinsTotal:100, intervalMin:180, sound:false,
    lastAppliedAt:0, nextDueAt:0, region:'kanto', regionManual:false,
    parts:{'base-sun':1,'eye-normal':1,'mouth-smile':1,'ray-togari':1},
    wear:{base:'base-sun',bg:'none',ray:'ray-togari',wear:'none',cheek:'none',
      eye:'eye-normal',mouth:'mouth-smile',glasses:'none',neck:'none',hat:'none',hand:'none',fx:'none'},
    migrated:true,lastDate:'',streak:0,bestStreak:0,total:0,log:{},col:{}
  };
}

function lockManager(){
  let tail = Promise.resolve();
  return {
    count:0,
    request(_name, _options, callback){
      this.count++;
      const result = tail.then(() => callback());
      tail = result.catch(() => {});
      return result;
    }
  };
}

async function boot({ state, now, shared, locks, failWrites=false, failReads=0, slowReads=false,
  geo, fetchImpl, blockLocalStorage=false, probeValue } = {}){
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && (e.stack || e))));
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));
  const dom = new JSDOM(html, {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.test/index.html', virtualConsole:vc,
    beforeParse(w){
      let clock = now == null ? Date.now() : now;
      if (now != null){
        const RealDate = w.Date;
        class FakeDate extends RealDate {
          constructor(...args){ super(...(args.length ? args : [clock])); }
          static now(){ return clock; }
        }
        w.Date = FakeDate;
        w.__setNow = value => { clock = value; };
      }
      w.setInterval = () => 1;
      w.clearInterval = () => {};
      w.AudioContext = class {
        constructor(){ this.state='running'; this.currentTime=0; this.destination={}; }
        resume(){ return Promise.resolve(); }
        createOscillator(){ return {frequency:{value:0},connect(){},start(){},stop(){}}; }
        createGain(){ return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}; }
      };
      Object.defineProperty(w.navigator, 'geolocation', { configurable:true,
        value:geo || { getCurrentPosition(_ok, fail){ if (fail) fail(new Error('denied')); } } });
      if (locks) Object.defineProperty(w.navigator, 'locks', { configurable:true, value:locks });
      w.fetch = fetchImpl || (async () => { throw new Error('offline'); });
      if (blockLocalStorage){
        Object.defineProperty(w, 'localStorage', { configurable:true, get(){ throw new Error('storage blocked'); } });
      } else if (probeValue !== undefined){
        w.localStorage.setItem('__nurisan_storage_probe__', probeValue);
      }
      if (shared){
        w.storage = {
          async get(k){
            if (failReads > 0){ failReads--; throw new Error('forced read failure'); }
            const snapshot = shared.has(k) ? shared.get(k) : null;
            if (slowReads) await wait(12);
            return snapshot == null ? null : { value:snapshot };
          },
          async set(k, value){ if (failWrites) throw new Error('forced write failure'); shared.set(k, value); },
          async delete(k){ if (failWrites) throw new Error('forced delete failure'); shared.delete(k); }
        };
      } else if (state !== undefined && !blockLocalStorage) w.localStorage.setItem(KEY, JSON.stringify(state));
    }
  });
  if (shared && state !== undefined && !shared.has(KEY)) shared.set(KEY, JSON.stringify(state));
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once:true }));
  await wait(30);
  return { dom, w:dom.window, d:dom.window.document, errors };
}

const results = [];
function check(group, name, ok, detail=''){ results.push({group,name,ok:Boolean(ok),detail}); }
async function close(...xs){ xs.forEach(x => x.dom.window.close()); await wait(2); }

(async () => {
  // 一時的な読込失敗では初期値を保存せず、復旧後は元データを起点に更新する。
  {
    const state = baseState(); state.total = 42;
    const shared = new Map([[KEY, JSON.stringify(state)]]);
    const x = await boot({state,shared,failReads:1,now:new Date(2026,7,5,9).getTime()});
    const warning = x.d.querySelector('#onboardStatus');
    check('persistence','transient initial read failure never overwrites stored data and stays visible',
      JSON.parse(shared.get(KEY)).total === 42 && x.w.eval('S.total') === 0 && x.w.eval('stateReadFailed')
        && warning.classList.contains('show') && warning.textContent.includes('上書きしない'),
      JSON.stringify({stored:JSON.parse(shared.get(KEY)).total,memory:x.w.eval('S.total'),warning:warning.textContent}));
    await x.w.eval('onNutta()'); await wait(20);
    const recovered = JSON.parse(shared.get(KEY));
    check('persistence','first successful mutation reloads and preserves data after a read failure',
      recovered.total === 43 && x.w.eval('S.total') === 43 && !x.w.eval('stateReadFailed'),
      JSON.stringify({stored:recovered.total,memory:x.w.eval('S.total'),readFailed:x.w.eval('stateReadFailed')}));
    await close(x);
  }

  // localStorageが使えない場合も、初回画面の中で揮発性を明示する。
  {
    const x = await boot({blockLocalStorage:true});
    const status = x.d.querySelector('#onboardStatus');
    check('persistence','memory-only fallback warning is visible inside onboarding',
      x.w.eval('store.kind') === 'mem' && x.d.querySelector('#onboard').classList.contains('show')
        && status.classList.contains('show') && status.textContent.includes('がめんをとじるときえちゃう'),
      JSON.stringify({kind:x.w.eval('store.kind'),shown:status.classList.contains('show'),text:status.textContent}));
    await close(x);
  }

  // 保存可否の確認に使うキーが既にあっても値を壊さない。
  {
    const x = await boot({state:baseState(),probeValue:'keep-me'});
    check('persistence','storage capability probe preserves a pre-existing same-origin value',
      x.w.localStorage.getItem('__nurisan_storage_probe__') === 'keep-me',
      x.w.localStorage.getItem('__nurisan_storage_probe__'));
    await close(x);
  }

  // 保存失敗は成功扱いにせず、画面上の変更も元に戻す。
  {
    const state = baseState(); state.total = 10;
    const shared = new Map([[KEY, JSON.stringify(state)]]);
    const x = await boot({state,shared,failWrites:true,now:new Date(2026,7,5,9).getTime()});
    await x.w.eval('onNutta()');
    const afterRecord = JSON.parse(shared.get(KEY));
    check('persistence','failed record is rolled back in memory and storage',
      afterRecord.total === 10 && x.w.eval('S.total') === 10 && !x.d.querySelector('#gacha').classList.contains('show'),
      JSON.stringify({stored:afterRecord.total,memory:x.w.eval('S.total'),banner:x.d.querySelector('#bannerText').textContent}));
    x.d.querySelector('#gearBtn').click();
    x.d.querySelector('#resetBtn').click(); x.d.querySelector('#resetBtn').click();
    await wait(30);
    const afterReset = JSON.parse(shared.get(KEY));
    const status = x.d.querySelector('#settingsStatus').textContent;
    check('persistence','failed reset keeps old data and reports an error inside the dialog',
      afterReset.total === 10 && x.w.eval('S.total') === 10
        && x.d.querySelector('#settings').classList.contains('show')
        && status.includes('ほぞんできなかった') && !status.includes('データをけしたよ'),
      JSON.stringify({stored:afterReset.total,memory:x.w.eval('S.total'),status}));
    await close(x);
  }

  // 同じ保存領域を使う2画面で、記録と設定変更が同時でも両方を残す。
  {
    const state = baseState();
    const shared = new Map([[KEY, JSON.stringify(state)]]);
    const locks = lockManager();
    const a = await boot({state,shared,locks,slowReads:true,now:new Date(2026,7,5,9).getTime()});
    const b = await boot({state,shared,locks,slowReads:true,now:new Date(2026,7,5,9).getTime()});
    const record = a.w.eval('onNutta()');
    b.d.querySelector('#intervalSeg button[data-min="120"]').click();
    await record; await wait(80);
    const saved = JSON.parse(shared.get(KEY));
    check('concurrency','simultaneous record and setting change both persist',
      saved.total === 1 && saved.intervalMin === 120 && locks.count >= 2,
      JSON.stringify({total:saved.total,intervalMin:saved.intervalMin,lockRequests:locks.count}));
    await close(a,b);
  }

  // 旧版から所有済みになったパーツは、累計コインが少なくても選べる。
  {
    const state = baseState();
    Object.assign(state,{migrated:false,total:8,coins:0,coinsTotal:0,col:{dolphin:1,cloud:1}});
    const x = await boot({state});
    const visible = ['base-dolphin','base-cloud'].every(id => x.d.querySelector(`#dressGrid [data-id="${id}"]`));
    check('migration','legacy-owned parts remain visible and selectable',visible,
      JSON.stringify({owned:Object.keys(x.w.eval('S.parts')),html:[...x.d.querySelectorAll('#dressGrid [data-id]')].map(e=>e.dataset.id)}));
    await close(x);
  }

  // 2025年行政区域の1902代表点を恒久テストする。
  {
    const x = await boot({state:baseState()});
    const classify = x.w.eval('(lat,lon) => regionFromCoords(lat,lon)');
    const bad = regionSamples.filter(([,lat,lon,want]) => classify(lat,lon) !== want)
      .map(([name,lat,lon,want]) => `${name}:${classify(lat,lon)}!=${want}`);
    check('region','1902 administrative-area representative points match',bad.length === 0,bad.slice(0,20).join(';') || '1902/1902');
    await close(x);
  }
  {
    const x = await boot({state:baseState()});
    const classify = x.w.eval('(lat,lon) => regionFromCoords(lat,lon)');
    const cases = [
      ['小笠原',27.094,142.191,'kanto'],['奄美',28.377,129.494,'okinawa'],
      ['南鳥島',24.289,153.979,'kanto'],['沖ノ鳥島',20.425,136.075,'kanto'],
      ['シドニー',-33.8688,151.2093,null],['ケープタウン',-33.9249,18.4241,null],
      ['ニューヨーク',40.7128,-74.006,null],['ゼロ座標',0,0,null]
    ];
    const bad = cases.filter(([,lat,lon,want]) => classify(lat,lon) !== want)
      .map(([name,lat,lon,want]) => `${name}:${classify(lat,lon)}!=${want}`);
    check('region','island fallbacks stay valid without classifying overseas coordinates as Japan',
      bad.length === 0,bad.join(';') || '8/8');
    await close(x);
  }

  // 権限取り消しは位置キャッシュを消し、古い通信結果は新しい結果を上書きしない。
  {
    let allowed = true;
    const geo = { getCurrentPosition(ok, fail){
      if (allowed) ok({coords:{latitude:35.68,longitude:139.77}});
      else if (fail) fail(new Error('revoked'));
    }};
    const x = await boot({state:baseState(),geo,
      fetchImpl:async()=>({ok:true,status:200,json:async()=>({current:{uv_index:6.4}})})});
    await wait(30); allowed = false; x.w.eval('initLiveUV(liveUvSession,true)'); await wait(15);
    const runtime = x.w.eval('({lastPos,uvLive,badge:document.getElementById("uvBadge").textContent})');
    check('privacy','permission revocation clears live UV and location cache',
      runtime.lastPos === null && runtime.uvLive === null && runtime.badge === 'ちいきべつ',JSON.stringify(runtime));
    await close(x);
  }
  {
    let geoCalls = 0, fetchCalls = 0;
    const start = new Date(2026,7,5,9).getTime();
    const geo = { getCurrentPosition(ok){ geoCalls++; ok({coords:{latitude:35.68,longitude:139.77}}); } };
    const x = await boot({state:baseState(),now:start,geo,
      fetchImpl:async()=>{ fetchCalls++; return {ok:true,status:200,json:async()=>({current:{uv_index:5.5}})}; }});
    await wait(20);
    for (let i=0;i<5;i++) x.w.eval('resumeLiveUVUpdates()');
    await wait(20);
    const fresh = {geoCalls,fetchCalls};
    x.w.__setNow(start + 30 * 60000);
    x.w.eval('resumeLiveUVUpdates()'); await wait(20);
    check('network','visibility resumes are throttled until the 30-minute refresh boundary',
      fresh.geoCalls === 1 && fresh.fetchCalls === 1 && geoCalls === 2 && fetchCalls === 2,
      JSON.stringify({fresh,afterBoundary:{geoCalls,fetchCalls}}));
    await close(x);
  }
  {
    const pending = [];
    const x = await boot({state:baseState(),fetchImpl:url=>new Promise(resolve=>pending.push({url:String(url),resolve}))});
    x.w.eval('lastPos={lat:35.68,lon:139.77}');
    const first = x.w.eval('refreshLiveUV()');
    x.w.eval('lastPos={lat:34.98,lon:138.38}');
    const second = x.w.eval('refreshLiveUV()');
    pending[1].resolve({ok:true,status:200,json:async()=>({current:{uv_index:8.1}})}); await second;
    pending[0].resolve({ok:true,status:200,json:async()=>({current:{uv_index:2.2}})}); await first;
    check('network','older UV response cannot overwrite the newer response',x.w.eval('uvLive') === 8.1,
      JSON.stringify({uv:x.w.eval('uvLive'),requests:pending.length}));
    await close(x);
  }

  // starter値と所有データが食い違ったときは、欠けた固定パーツから再開する。
  {
    const state = baseState();
    state.starter = 3; state.total = 3; state.parts = {'base-sun':1}; state.wear = {
      base:'base-sun',bg:'none',ray:'none',wear:'none',cheek:'none',eye:'none',mouth:'none',
      glasses:'none',neck:'none',hat:'none',hand:'none',fx:'none'};
    const x = await boot({state,now:new Date(2026,7,5,9).getTime()});
    const repaired = x.w.eval('S.starter') === 0;
    await x.w.eval('onNutta()');
    check('repair','missing starter reward is granted instead of coins',
      repaired && x.w.eval('S.starter') === 1 && x.w.eval('S.parts["eye-normal"]') === 1 && x.w.eval('S.coins') === 10,
      JSON.stringify({starter:x.w.eval('S.starter'),coins:x.w.eval('S.coins'),parts:x.w.eval('S.parts')}));
    await close(x);
  }

  // localStorage.clear()相当の通知でも、古い状態を復活させない。
  {
    const x = await boot({state:baseState()});
    x.w.dispatchEvent(new x.w.StorageEvent('storage',{key:null,newValue:null})); await wait(10);
    const runtime = x.w.eval('({onboard:S.onboard,liveUvStarted,total:S.total})');
    check('concurrency','storage.clear event resets runtime and stops location updates',
      runtime.onboard === false && runtime.liveUvStarted === false && runtime.total === 0
        && x.d.querySelector('#onboard').classList.contains('show'),JSON.stringify(runtime));
    await close(x);
  }

  // AudioContextが作られても再開できない間は、操作ヒントを消さない。
  {
    const state = baseState(); state.sound = true;
    state.lastAppliedAt = new Date(2026,7,5,8).getTime(); state.nextDueAt = new Date(2026,7,5,11).getTime();
    state.log['2026-08-05'] = 1; state.lastDate = '2026-08-05';
    const x = await boot({state,now:new Date(2026,7,5,9).getTime()});
    x.w.eval("ac={state:'suspended'}; renderHome('active')");
    check('audio','suspended audio context keeps the tap-to-enable hint visible',
      x.d.querySelector('#stSub').textContent.includes('画面を一度タップ'),x.d.querySelector('#stSub').textContent);
    await close(x);
  }

  // 23時間の日でも「きのう」をカレンダー日として扱う。
  {
    const previousTZ = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const state = baseState();
      Object.assign(state,{lastDate:'2025-03-09',streak:4,bestStreak:4,total:4,log:{'2025-03-09':1}});
      const now = new Date(2025,2,10,0,30).getTime();
      const x = await boot({state,now});
      await x.w.eval('onNutta()'); await wait(15);
      const days = x.d.querySelector('#dayList').textContent;
      check('time','DST spring transition preserves yesterday streak and two-week calendar labels',
        x.w.eval('yesterday()') === '2025-03-09' && x.w.eval('S.streak') === 5
          && x.w.eval('S.log["2025-03-10"]') === 1 && days.includes('3/9') && days.includes('3/10'),
        JSON.stringify({yesterday:x.w.eval('yesterday()'),streak:x.w.eval('S.streak'),days}));
      await close(x);
    } finally {
      if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
    }
  }

  for (const r of results) console.log(`${r.ok?'PASS':'FAIL'}\t${r.group}\t${r.name}\t${r.detail}`);
  const failed = results.filter(r => !r.ok);
  console.log(`SUMMARY\t${results.length-failed.length} passed, ${failed.length} failed, ${results.length} total`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
