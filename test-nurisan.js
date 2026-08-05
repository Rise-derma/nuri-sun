const fs = require('fs');
const path = require('path');
const {JSDOM, VirtualConsole} = require('jsdom');

const bundledHtml = fs.existsSync(path.join(__dirname, 'nuri-sun-web.html')) ? 'nuri-sun-web.html' : 'index.html';
const htmlPath = process.env.NURISAN_HTML || path.join(__dirname, bundledHtml);
const rawHtml = fs.readFileSync(htmlPath, 'utf8');
const regionData = fs.readFileSync(path.join(path.dirname(htmlPath), 'region-data.js'), 'utf8');
const html = rawHtml.replace('<script src="./region-data.js"></script>', `<script>${regionData}</script>`);
const KEY = 'nurisan-v1';
const wait = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
let activeErrors = null;
process.on('unhandledRejection', e => activeErrors && activeErrors.push(String(e && (e.stack || e))));

async function boot({state, raw, now, geo, fetchImpl}={}){
  const errors=[]; activeErrors=errors;
  const vc=new VirtualConsole();
  vc.on('jsdomError', e=>errors.push(String(e && (e.stack||e))));
  vc.on('error', (...a)=>errors.push(a.map(String).join(' ')));
  const dom=new JSDOM(html,{
    runScripts:'dangerously',resources:'usable',pretendToBeVisual:true,
    url:'https://example.test/index.html',virtualConsole:vc,
    beforeParse(w){
      w.__audioContexts=0;w.__oscStarts=0;
      w.AudioContext=class{
        constructor(){this.state='running';this.currentTime=0;this.destination={};w.__audioContexts++;}
        resume(){this.state='running';return Promise.resolve();}
        createOscillator(){return{type:'',frequency:{value:0},connect(){},start(){w.__oscStarts++;},stop(){}};}
        createGain(){return{gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}
      };
      if(now!=null){
        const RealDate=w.Date;let clock=now;
        class FakeDate extends RealDate{constructor(...a){super(...(a.length?a:[clock]));}static now(){return clock;}}
        w.Date=FakeDate;w.__setNow=v=>{clock=v;};
      }
      Object.defineProperty(w.navigator,'geolocation',{configurable:true,value:geo||{getCurrentPosition(_ok,fail){fail&&fail(new Error('denied'));}}});
      w.fetch=fetchImpl||(async()=>{throw new Error('offline test');});
      if(raw!==undefined)w.localStorage.setItem(KEY,raw);
      else if(state!==undefined)w.localStorage.setItem(KEY,JSON.stringify(state));
    }
  });
  await new Promise(r=>dom.window.addEventListener('load',r,{once:true}));
  await wait(35);
  return{dom,w:dom.window,d:dom.window.document,errors};
}
const S=w=>w.eval('S');
const saved=w=>w.localStorage.getItem(KEY);
const close=async x=>{x.dom.window.close();await wait(2);};
const baseState=()=>({uid:'u-test',onboard:true,starter:3,coins:0,coinsTotal:0,intervalMin:180,sound:false,lastAppliedAt:0,nextDueAt:0,region:'kanto',regionManual:false,parts:{'base-sun':1,'eye-normal':1,'mouth-smile':1,'ray-togari':1},wear:{base:'base-sun',bg:'none',ray:'ray-togari',wear:'none',cheek:'none',eye:'eye-normal',mouth:'mouth-smile',glasses:'none',neck:'none',hat:'none',hand:'none',fx:'none'},migrated:true,lastDate:'',streak:0,bestStreak:0,total:0,log:{},col:{}});

const out=[];
function test(name,ok,detail=''){out.push({name,ok:!!ok,detail});}

(async()=>{
  {
    let geoCalls=0;
    const geo={getCurrentPosition(_ok,fail){geoCalls++;fail&&fail(new Error('denied'));}};
    const x=await boot({geo});
    const ids=[...x.d.querySelectorAll('[id]')].map(e=>e.id);
    const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
    const refs=[...html.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]);
    const missing=[...new Set(refs)].filter(id=>!x.d.getElementById(id));
    test('fresh boot has no runtime error',x.errors.length===0,x.errors[0]||'none');
    test('DOM ids and JS id references are valid',dup.length===0&&missing.length===0,`duplicate=${dup}; missing=${missing}`);
    test('fresh state owns base and is current schema',S(x.w).parts['base-sun']===1&&S(x.w).migrated===true,JSON.stringify({parts:S(x.w).parts,migrated:S(x.w).migrated}));
    test('fresh normalized state is persisted',JSON.parse(saved(x.w)).migrated===true&&JSON.parse(saved(x.w)).parts['base-sun']===1,saved(x.w));
    test('no geolocation request before first-run acknowledgement',geoCalls===0,`calls=${geoCalls}`);
    const onboardPrivacy=x.d.querySelector('#onboardPrivacy'),settingsPrivacy=x.d.querySelector('#settingsPrivacy');
    test('Open-Meteo log retention is disclosed before location consent',
      x.d.querySelector('#onboard').classList.contains('show')&&onboardPrivacy.textContent.includes('IPアドレス')
        &&onboardPrivacy.textContent.includes('90日後')&&onboardPrivacy.parentElement.textContent.includes('およそ1km')
        &&settingsPrivacy.textContent.includes('IPアドレス')&&settingsPrivacy.textContent.includes('90日後'));
    const privacyLinks=[x.d.querySelector('#onboardPrivacyLink'),x.d.querySelector('#settingsPrivacyLink')];
    test('Open-Meteo privacy links use the official HTTPS terms page safely',privacyLinks.every(a=>
      a&&a.href==='https://open-meteo.com/en/terms'&&a.target==='_blank'&&a.rel.split(/\s+/).includes('noopener')),
      privacyLinks.map(a=>a&&`${a.href}/${a.target}/${a.rel}`).join(' | '));
    test('dialogs expose modal semantics',[...x.d.querySelectorAll('.overlay')].every(e=>e.getAttribute('role')==='dialog'&&e.getAttribute('aria-modal')==='true'));
    test('dress tiles are keyboard-focusable buttons',x.d.querySelectorAll('#dressGrid button.tile').length>0,`buttons=${x.d.querySelectorAll('#dressGrid button.tile').length}`);
    x.d.querySelector('#obStart').click();await wait(20);
    test('geolocation starts after acknowledgement',geoCalls===1,`calls=${geoCalls}`);
    await close(x);
  }

  {
    let requested='';
    const geo={getCurrentPosition(ok){ok({coords:{latitude:35.681234,longitude:139.767891}});}};
    const fetchImpl=async url=>{requested=String(url);return{ok:true,status:200,json:async()=>({current:{uv_index:6.26}})};};
    const x=await boot({state:baseState(),geo,fetchImpl});await wait(30);
    test('coordinates are rounded before API transmission',requested.includes('latitude=35.68')&&requested.includes('longitude=139.77')&&!requested.includes('35.681234'),requested);
    test('live UV is rounded and labelled forecast',x.d.querySelector('#uvVal').textContent==='UVレベル 6.3'&&x.d.querySelector('#uvBadge').textContent==='いまのよそう',`${x.d.querySelector('#uvVal').textContent}/${x.d.querySelector('#uvBadge').textContent}`);
    await close(x);
  }

  {
    const t0=new Date(2026,7,4,9).getTime();const x=await boot({now:t0});x.d.querySelector('#obStart').click();await wait(5);
    for(let i=0;i<3;i++){x.w.__setNow(t0+i*31*60000);await x.w.eval('onNutta()');}
    test('first three records grant three starter parts only',S(x.w).total===3&&S(x.w).starter===3&&S(x.w).coins===0&&['eye-normal','mouth-smile','ray-togari'].every(id=>S(x.w).parts[id]),JSON.stringify({total:S(x.w).total,starter:S(x.w).starter,coins:S(x.w).coins}));
    x.w.Math.random=()=>0.5;x.w.__setNow(t0+3*31*60000);await x.w.eval('onNutta()');
    test('fourth record grants one coin',S(x.w).total===4&&S(x.w).coins===1&&S(x.w).coinsTotal===1,JSON.stringify({total:S(x.w).total,coins:S(x.w).coins}));
    const before=S(x.w).total;await Promise.all([x.w.eval('onNutta()'),x.w.eval('onNutta()')]);
    test('rapid duplicate records are blocked',S(x.w).total===before,`before=${before},after=${S(x.w).total}`);
    await close(x);
  }

  {
    const s=baseState();Object.assign(s,{coins:20,coinsTotal:50,total:20});
    const x=await boot({state:s});x.d.querySelector('#resetBtn').click();x.d.querySelector('#resetBtn').click();await wait(25);
    test('reset immediately restores base and current schema',S(x.w).parts['base-sun']===1&&S(x.w).migrated===true&&S(x.w).starter===0,JSON.stringify({parts:S(x.w).parts,migrated:S(x.w).migrated,starter:S(x.w).starter}));
    test('reset zukan starts at one owned part',x.d.querySelector('#colCount').textContent==='1 / 58',x.d.querySelector('#colCount').textContent);
    x.d.querySelector('#obStart').click();await wait(5);await x.w.eval('onNutta()');
    const raw=saved(x.w);const y=await boot({raw});
    test('reset + one record + reload preserves starter progress',S(y.w).total===1&&S(y.w).starter===1&&S(y.w).parts['eye-normal']===1&&!S(y.w).parts['mouth-smile']&&!S(y.w).parts['ray-togari'],JSON.stringify({total:S(y.w).total,starter:S(y.w).starter,parts:S(y.w).parts}));
    await close(x);await close(y);
  }

  for(const badParts of ['bad',17,true]){
    const now=new Date(2026,7,4,10).getTime(),day=dayKey(now),s=baseState();
    Object.assign(s,{migrated:false,total:77,coins:8,coinsTotal:8,log:{[day]:7},parts:badParts,starter:0});
    const x=await boot({state:s,now});const p=JSON.parse(saved(x.w));
    test(`malformed pre-migration parts preserve records (${typeof badParts})`,S(x.w).total===77&&S(x.w).coins===8&&S(x.w).log[day]===7&&p.total===77&&p.migrated===true,JSON.stringify({state:{total:S(x.w).total,coins:S(x.w).coins,log:S(x.w).log},saved:{total:p.total,migrated:p.migrated}}));
    await close(x);
  }

  {
    const now=new Date(2026,7,4,10).getTime(),day=dayKey(now),s=baseState();
    Object.assign(s,{region:'bad',regionManual:'false',onboard:'false',migrated:'false',lastDate:'2026-99-99',log:{'2026-99-99':4,[day]:1},lastAppliedAt:now,nextDueAt:now+20*3600000,sound:'false'});
    const x=await boot({state:s,now});const g=S(x.w),p=JSON.parse(saved(x.w));
    test('invalid enum booleans and dates are normalized',g.region==='kanto'&&g.regionManual===false&&g.onboard===false&&g.migrated===true&&g.lastDate===''&&!g.log['2026-99-99']&&g.sound===true,JSON.stringify({region:g.region,regionManual:g.regionManual,onboard:g.onboard,migrated:g.migrated,lastDate:g.lastDate,sound:g.sound}));
    test('impossible 20-hour countdown is cleared',g.nextDueAt===0,`nextDueAt=${g.nextDueAt}`);
    test('repaired state is persisted',p.region==='kanto'&&p.regionManual===false&&p.migrated===true&&!p.log['2026-99-99']&&p.nextDueAt===0,JSON.stringify(p));
    await close(x);
  }

  {
    const now=new Date(2026,7,4,10).getTime(),day=dayKey(now),s=baseState();
    Object.assign(s,{lastDate:day,streak:1,bestStreak:1,total:1,log:{[day]:1},lastAppliedAt:now+86400000,nextDueAt:now+86400000});
    const x=await boot({state:s,now});await x.w.eval('onNutta()');
    test('future timestamps do not lock recording',S(x.w).total===2,`total=${S(x.w).total}`);
    await close(x);
  }

  {
    const x=await boot();
    const capitals=[
      ['札幌',43.0621,141.3544,'hokkaido'],['青森',40.8244,140.7400,'tohoku'],['盛岡',39.7036,141.1527,'tohoku'],['仙台',38.2682,140.8694,'tohoku'],['秋田',39.7186,140.1024,'tohoku'],['山形',38.2404,140.3633,'tohoku'],['福島',37.7503,140.4676,'tohoku'],
      ['水戸',36.3418,140.4468,'kanto'],['宇都宮',36.5551,139.8828,'kanto'],['前橋',36.3895,139.0634,'kanto'],['さいたま',35.8617,139.6455,'kanto'],['千葉',35.6074,140.1065,'kanto'],['東京',35.6895,139.6917,'kanto'],['横浜',35.4478,139.6425,'kanto'],
      ['新潟',37.9026,139.0236,'chubu'],['富山',36.6953,137.2113,'chubu'],['金沢',36.5947,136.6256,'chubu'],['福井',36.0652,136.2216,'chubu'],['甲府',35.6642,138.5685,'chubu'],['長野',36.6513,138.1810,'chubu'],['岐阜',35.3912,136.7223,'chubu'],['静岡',34.9769,138.3831,'chubu'],['名古屋',35.1802,136.9066,'chubu'],
      ['津',34.7303,136.5086,'kinki'],['大津',35.0045,135.8686,'kinki'],['京都',35.0210,135.7556,'kinki'],['大阪',34.6863,135.5200,'kinki'],['神戸',34.6913,135.1830,'kinki'],['奈良',34.6851,135.8048,'kinki'],['和歌山',34.2260,135.1675,'kinki'],
      ['鳥取',35.5039,134.2383,'chugoku'],['松江',35.4723,133.0505,'chugoku'],['岡山',34.6618,133.9344,'chugoku'],['広島',34.3966,132.4596,'chugoku'],['山口',34.1861,131.4705,'chugoku'],['徳島',34.0658,134.5593,'chugoku'],['高松',34.3401,134.0434,'chugoku'],['松山',33.8416,132.7661,'chugoku'],['高知',33.5597,133.5311,'chugoku'],
      ['福岡',33.6064,130.4183,'kyushu'],['佐賀',33.2494,130.2988,'kyushu'],['長崎',32.7503,129.8777,'kyushu'],['熊本',32.7898,130.7417,'kyushu'],['大分',33.2382,131.6126,'kyushu'],['宮崎',31.9111,131.4239,'kyushu'],['鹿児島',31.5602,130.5581,'kyushu'],['那覇',26.2124,127.6809,'okinawa']
    ];
    const edges=[['姫路',34.8151,134.6853,'kinki'],['赤穂',34.7548,134.3909,'kinki'],['彦根',35.2745,136.2596,'kinki'],['いなべ',35.1157,136.5613,'kinki'],['御殿場',35.3086,138.9345,'chubu'],['上野原',35.6302,139.1087,'chubu'],['嬬恋',36.5167,138.5306,'kanto'],['関川',38.0895,139.5649,'chubu'],['行橋',33.7287,130.9830,'kyushu'],['姫島',33.7245,131.6459,'kyushu'],['下関',33.9578,130.9415,'chugoku']];
    const bad=a=>a.filter(([,lat,lon,want])=>x.w.eval(`regionFromCoords(${lat},${lon})`)!==want).map(([n,lat,lon,want])=>`${n}:${x.w.eval(`regionFromCoords(${lat},${lon})`)}!=${want}`);
    const badCap=bad(capitals),badEdge=bad(edges);
    test('47 prefectural capitals match selected regions',badCap.length===0,badCap.join(';')||'47/47');
    test('11 representative border cities match selected regions',badEdge.length===0,badEdge.join(';')||'11/11');
    await close(x);
  }

  {
    const s=baseState();Object.assign(s,{coins:1,coinsTotal:100});const x=await boot({state:s});
    x.w.eval("dressCat='bg';renderDress()");const target=[...x.d.querySelectorAll('#dressGrid button.tile.buyable')].find(t=>x.w.eval(`PRICE[partById('${t.dataset.id}').r]`)===1);const id=target.dataset.id;
    target.click();await wait(5);const armed=!!x.d.querySelector(`#dressGrid [data-id='${id}'].confirm`);x.d.querySelector(`#dressGrid [data-id='${id}']`).click();await wait(20);
    test('two-tap purchase charges once, equips and persists',armed&&S(x.w).coins===0&&S(x.w).parts[id]===1&&S(x.w).wear.bg===id&&JSON.parse(saved(x.w)).parts[id]===1,`id=${id},coins=${S(x.w).coins},wear=${S(x.w).wear.bg}`);
    await close(x);
  }

  {
    const x=await boot();const sw=x.d.querySelector('#soundSw'),before=sw.checked;x.d.querySelector('.switch i').click();await wait(20);
    test('sound switch track toggles setting',sw.checked!==before&&S(x.w).sound===sw.checked,`before=${before},after=${sw.checked},state=${S(x.w).sound}`);
    await close(x);
  }

  {
    const now=new Date(2026,7,4,10).getTime(),day=dayKey(now),s=baseState();Object.assign(s,{sound:true,total:4,lastDate:day,streak:1,bestStreak:1,log:{[day]:1},lastAppliedAt:now-3*3600000,nextDueAt:now-1000});
    const x=await boot({state:s,now});x.w.eval('tick()');
    const before=x.w.eval('({ac:!!ac,dueChimes,starts:window.__oscStarts})');
    x.d.body.dispatchEvent(new x.w.Event('pointerdown',{bubbles:true}));await wait(5);x.w.eval('tick()');
    const after=x.w.eval('({ac:!!ac,dueChimes,starts:window.__oscStarts})');
    test('due reminder waits for gesture then plays audio',!before.ac&&before.dueChimes===0&&after.ac&&after.dueChimes===1&&after.starts>0,JSON.stringify({before,after}));
    await close(x);
  }

  {
    const x=await boot({fetchImpl:async()=>({ok:true,status:200,json:async()=>({current:{uv_index:6.26}})})});
    test('fetchUV rounds current value',await x.w.eval('fetchUV(35.6,139.7)')===6.3);
    await close(x);
  }
  {
    const x=await boot({fetchImpl:async()=>({ok:false,status:500,json:async()=>({current:{uv_index:4.2}})})});let rejected=false;try{await x.w.eval('fetchUV(35.6,139.7)');}catch(e){rejected=true;}
    test('fetchUV rejects HTTP errors',rejected,`rejected=${rejected}`);await close(x);
  }
  {
    const x=await boot({fetchImpl:async()=>({ok:true,status:200,json:async()=>({current:{uv_index:-0.2}})})});
    test('fetchUV clamps negative model value to zero',await x.w.eval('fetchUV(35.6,139.7)')===0);await close(x);
  }

  {
    const at2350=new Date(2026,7,4,23,50).getTime(),at0005=new Date(2026,7,5,0,5).getTime();const x=await boot({now:at2350});x.d.querySelector('#obStart').click();await wait(5);await x.w.eval('onNutta()');x.w.__setNow(at0005);x.w.eval('tick()');await x.w.eval('onNutta()');
    test('midnight creates next-day record and streak',S(x.w).total===2&&S(x.w).streak===2&&S(x.w).log['2026-08-04']===1&&S(x.w).log['2026-08-05']===1,JSON.stringify({total:S(x.w).total,streak:S(x.w).streak,log:S(x.w).log}));await close(x);
  }

  {
    const now=new Date(2026,7,5,9).getTime(),prev=new Date(2026,7,4,9).getTime(),s=baseState();Object.assign(s,{lastDate:dayKey(prev),streak:2,bestStreak:2,total:2,log:{[dayKey(prev)]:1},lastAppliedAt:prev});const x=await boot({state:s,now});await x.w.eval('onNutta()');
    test('three-day streak grants bronze reward',S(x.w).streak===3&&S(x.w).parts['neck-bronze']===1,JSON.stringify({streak:S(x.w).streak,bronze:S(x.w).parts['neck-bronze']}));await close(x);
  }

  {
    const x=await boot();const parts=x.w.eval('PARTS.map(p=>({id:p.id,cat:p.cat,r:p.r}))'),ids=parts.map(p=>p.id),cats=x.w.eval('CATS.map(c=>c.id)');
    test('58 part definitions are unique and valid',parts.length===58&&new Set(ids).size===58&&parts.every(p=>cats.includes(p.cat)&&[1,2,3,4].includes(p.r)),`count=${parts.length},unique=${new Set(ids).size}`);
    const firstTip='ローションなら、顔に500円玉1つ分か1円玉2つ分がめやす。少なすぎるとパッケージどおりの力が出にくいよ。';
    test('21 final tips and approved wording are present',x.w.eval('TIPS.length')===21&&x.w.eval('TIPS[0].t')===firstTip&&x.w.eval('TIPS[20].t').includes('まもる力がふえるよ'),`count=${x.w.eval('TIPS.length')}; first=${x.w.eval('TIPS[0].t')}`);
    const credit=x.d.querySelector('.credit').textContent;
    test('data sources, licence and transformations are disclosed',!!x.d.querySelector('a[href="https://open-meteo.com/"]')&&!!x.d.querySelector('a[href*="creativecommons.org/licenses/by/4.0"]')&&!!x.d.querySelector('a[href*="data.jma.go.jp"]')&&credit.includes('小数1けたにまるめ')&&credit.includes('強さのなまえ'),credit.trim());
    await close(x);
  }

  {
    const G1='一右雨円王音下火花貝学気九休玉金空月犬見五口校左三山子四糸字耳七車手水十出女小上森人生正青夕石赤千川先早草足村大男竹中虫町天田土二日入年白八百文木本名目立力林六';
    const G2='引羽雲園遠何科夏家歌画回会海絵外角楽活間丸岩顔汽記帰弓牛魚京強教近兄形計元言原戸古午後語工公広交光考行高黄合谷国黒今才細作算止市矢姉思紙寺自時室社弱首秋週春書少場色食心新親図数西声星晴切雪船線前組走多太体台地池知茶昼長鳥朝直通弟店点電刀冬当東答頭同道読内南肉馬売買麦半番父風分聞米歩母方北毎妹万明鳴毛門夜野友用曜来里理話';
    const G3='悪安暗医委意育員院飲運泳駅央横屋温化荷界開階寒感漢館岸起期客究急級宮球去橋業曲局銀区苦具君係軽血決研県庫湖向幸港号根祭皿仕死使始指歯詩次事持式実写者主守取酒受州拾終習集住重宿所暑助昭消商章勝乗植申身神真深進世整昔全相送想息速族他打対待代第題炭短着注柱丁帳調追定庭笛鉄転都度投豆島湯登等動童農波配倍箱畑発反坂板皮悲美鼻筆氷表秒病品負部服福物平返勉放味命面問役薬由油有遊予羊洋葉陽様落流旅両緑礼列練路和';
    const allowed=new Set([...G1+G2+G3+'老']);const d=new JSDOM(html).window.document;d.querySelectorAll('style').forEach(e=>e.remove());const script=[...d.scripts].map(s=>s.textContent).join('\n');d.querySelectorAll('script').forEach(e=>e.remove());const chunks=[d.body.textContent,...[...script.matchAll(/'(?:\\.|[^'\\])*'/gs)].map(m=>m[0].slice(1,-1))];const bad=[...new Set(chunks.flatMap(t=>[...t]).filter(c=>/[\u4e00-\u9fff]/.test(c)&&!allowed.has(c)))].sort();
    test('child-facing kanji audit passes with only declared 老 exception',bad.length===0,bad.join(''));
  }

  for(const r of out)console.log(`${r.ok?'PASS':'FAIL'}\t${r.name}\t${r.detail}`);
  const failed=out.filter(r=>!r.ok);
  console.log(`SUMMARY\t${out.length-failed.length} passed, ${failed.length} failed, ${out.length} total`);
  if(failed.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
