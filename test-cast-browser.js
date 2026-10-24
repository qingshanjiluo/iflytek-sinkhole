// 双浏览器真实 E2E(CDP,零依赖):
// 1) Chrome headless(带远程调试)开 /cast/host,CDP 鼠标事件点「● 开始投屏」(trusted user activation + 自动选源)
// 2) 同浏览器另一页开 /cast,断言:双方 WS 连接状态 / host 观看者数 / viewer canvas 是否真收到帧
// 3) viewer 画布上派发鼠标事件 → 服务端回传 → host 端出现反控光标标记(#mc 显示)
// 前置:测试 relay 已监听 127.0.0.1:28799;结束自动杀本脚本起的 Chrome。
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const RPORT = 9333;
const RELAY = 'http://127.0.0.1:28799';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('ok ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); } }

/* ---- 极简 CDP 客户端 ---- */
function cdp(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const sock = net.connect(u.port, u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
    });
    let joined = false, buf = Buffer.alloc(0);
    const pend = new Map(); let seq = 0;
    sock.on('data', d => {
      if (!joined) {
        buf = Buffer.concat([buf, d]);
        const s = buf.toString('latin1');
        const i = s.indexOf('\r\n\r\n');
        if (i === -1) return;
        if (!s.startsWith('HTTP/1.1 101')) return reject(new Error('cdp ws no101 ' + s.slice(0, 40)));
        joined = true; resolve(c);
        d = buf.subarray(i + 4); buf = Buffer.alloc(0);
        if (!d.length) return;
      }
      buf = Buffer.concat([buf, d]);
      let b = buf;
      while (b.length >= 2) {
        const op = b[0] & 0x0f;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
        if (b.length < off + len) break;
        const payload = b.subarray(off, off + len);
        b = b.subarray(off + len);
        if (op === 1) {
          let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
          if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
        }
      }
      buf = b;
    });
    sock.on('error', e => reject(e));
    const c = {
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pend.set(id, m => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
          const body = Buffer.from(JSON.stringify({ id, method, params: params || {} }));
          const len = body.length; let head;
          if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
          else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
          const mask = crypto.randomBytes(4);
          const p = Buffer.from(body);
          for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
          sock.write(Buffer.concat([head, mask, p]));
          setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('cdp timeout ' + method)); } }, 8000);
        });
      },
      eval(expr) {
        return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false })
          .then(r => (r && r.result ? r.result.value : undefined));
      },
      close() { try { sock.destroy(); } catch {} },
    };
  });
}
function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
  });
}

(async () => {
  // 前置断言:relay 活
  try { await get(RELAY + '/api/info'); } catch (e) { console.log('BLOCKED relay 28799 down'); process.exit(2); }
  const prof = path.join(os.tmpdir(), 'cdp-cast-probe');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${prof}`,
    `--remote-debugging-port=${RPORT}`,
    '--no-proxy-server', // 本机代理环境会吞掉 ws://127.0.0.1,测试必须直连
    '--auto-select-desktop-capture-source=Entire screen',
    '--auto-accept-all-captures', // 新版 Chrome headless 自动接受 getDisplayMedia 选择器
    '--use-fake-ui-for-media-stream',
    '--allow-canvas-binary-media',
    `${RELAY}/`,
  ], { stdio: 'ignore' });
  let wsUrl = '';
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const list = await get(`http://127.0.0.1:${RPORT}/json/list`);
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) { console.log('BLOCKED no cdp target'); chrome.kill(); process.exit(3); }

  const c0 = await cdp(wsUrl);
  // 开两页:投屏台 + 观看端
  await c0.send('Target.createTarget', { url: `${RELAY}/cast/host?url=${encodeURIComponent(RELAY + '/')}` });
  await c0.send('Target.createTarget', { url: `${RELAY}/cast` });
  c0.close();
  await sleep(2500);
  const list2 = await get(`http://127.0.0.1:${RPORT}/json/list`);
  const hostT = list2.find(t => t.type === 'page' && /cast\/host/.test(t.url));
  const viewT = list2.find(t => t.type === 'page' && /\/cast$/.test(t.url || ''));
  T('找到两页目标', !!hostT && !!viewT, JSON.stringify(list2.filter(t => t.type === 'page').map(t => t.url)));
  if (!hostT || !viewT) { chrome.kill(); process.exit(4); }
  const H = await cdp(hostT.webSocketDebuggerUrl);
  const V = await cdp(viewT.webSocketDebuggerUrl);
  // 挂 close-code 钩子:下一次 ws 关闭时记录 code/reason(1006=TCP都没建,1000=服务端主动关,1002=协议错)
  const hookJs = `(function(){var w=ws; if(!w) return 'nows'; var old=w.onclose; w.onclose=function(e){window.__cc=e.code;window.__cr=e.reason;window.__cwhen=Date.now();if(old)try{return old.apply(this,arguments)}catch(x){}}; return 'hooked rs='+w.readyState;})()`;
  const hHook = await H.eval(hookJs);
  const vHook = await V.eval(hookJs);
  T('hook host', /hooked/.test(hHook || ''), hHook);
  T('hook view', /hooked/.test(vHook || ''), vHook);
  // raw 消息计数:替换两页 ws.onmessage(原 handler 包一层),不经 handle 作用域
  const rawHH = await H.eval(`(function(){window.__hn=0;window.__ht=[];var w=ws,old=w.onmessage;w.onmessage=function(e){if(typeof e.data==='string'){window.__hn++;try{window.__ht.push(JSON.parse(e.data).t)}catch(x){window.__ht.push('bad')}}return old?old.apply(this,arguments):null};return 'ok';})()`);
  const rawVH = await V.eval(`(function(){window.__vn=0;window.__vt=[];var w=ws,old=w.onmessage;w.onmessage=function(e){if(typeof e.data==='string'){window.__vn++;try{window.__vt.push(JSON.parse(e.data).t)}catch(x){window.__vt.push('bad')}}return old?old.apply(this,arguments):null};return 'ok';})()`);
  console.log('rawHook host=' + rawHH + ' view=' + rawVH);

  // 1) 双端 WS 已连
  await sleep(3500);
  const cc = await H.eval(`({c:window.__cc,r:window.__cr||'',when:window.__cwhen||0,rs:ws?ws.readyState:-1,url:ws?ws.url:'no-ws',loc:location.href})`);
  const vc = await V.eval(`({c:window.__cc,r:window.__cr||'',when:window.__cwhen||0,rs:ws?ws.readyState:-1,url:ws?ws.url:'no-ws',loc:location.href})`);
  console.log('host closeinfo=' + JSON.stringify(cc) + ' view closeinfo=' + JSON.stringify(vc));
  const hst = await H.eval(`document.getElementById('stPill')?document.getElementById('stPill').textContent:''`);
  T('host WS 已连接', /已连接/.test(hst || ''), 'stPill=' + hst);
  const vst = await V.eval(`document.getElementById('stP')?document.getElementById('stP').textContent:''`);
  T('viewer WS 已连接', /已连接/.test(vst || ''), 'stP=' + vst);
  const vcount = await H.eval(`document.getElementById('viewPill').textContent`);
  T('host 观看者=1', /1/.test(vcount || ''), 'pill=' + vcount);

  // 2) host 点「● 开始投屏」(CDP 真实鼠标事件=trusted activation)
  const box = await H.eval(`(function(){var b=document.getElementById('cast').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
  T('拿到投屏按钮坐标', !!box && typeof box.x === 'number', JSON.stringify(box));
  if (box) {
    await H.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await H.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
    await H.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  }
  await sleep(3500);
  const capP = await H.eval(`document.getElementById('capPill').textContent`);
  console.log('post-click capPill=' + capP + ' | lastToast=' + await H.eval(`document.getElementById('toast').textContent`) + ' | castErr=' + await H.eval(`window.__castErr||''`));
  T('host 投屏中(getDisplayMedia 自动接受)', /投屏中/.test(capP || ''), 'capPill=' + capP + ' stPill=' + await H.eval(`document.getElementById('stPill').textContent`));

  // 3) viewer 真收到帧(canvas 有尺寸且 ph 隐藏)
  await sleep(4000);
  const diagH = await H.eval(`({ans:gotAns,pcst:pc?pc.connectionState:'noc',dcst:dc?dc.readyState:'nod',ice:pc&&pc.iceConnectionState,sign:pc&&pc.signalingState})`);
  const diagV = await V.eval(`({pcst:(typeof pc!=='undefined'&&pc)?pc.connectionState:'noc',sig:(typeof pc!=='undefined'&&pc)?pc.signalingState:'-',vw:(typeof v!=='undefined'&&v)?v.videoWidth:-1,ansSent:(typeof sentAns!=='undefined')?sentAns:'?'})`);
  console.log('diagH=' + JSON.stringify(diagH) + ' diagV=' + JSON.stringify(diagV));
  console.log('hostRaw=' + JSON.stringify(await H.eval(`({n:window.__hn||0,t:window.__ht||[]})`)) + ' viewRaw=' + JSON.stringify(await V.eval(`({n:window.__vn||0,t:window.__vt||[]})`)));
  const vw = await V.eval(`(function(){var c=document.getElementById('cv');return {w:c.width,h:c.height,disp:c.style.display,ph:document.getElementById('ph').style.display}})()`);
  T('viewer 收到画面帧', vw && vw.w > 100 && vw.h > 100 && vw.disp === 'block', JSON.stringify(vw));

  // 4) 反控闭环:viewer 画布中心发鼠标 → host 页 #mc 光标标记出现
  if (vw && vw.w > 100) {
    const vb = await V.eval(`(function(){var r=document.getElementById('cv').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()`);
    await V.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vb.x, y: vb.y, buttons: 0 });
    await V.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vb.x, y: vb.y, button: 'left', buttons: 1, clickCount: 1 });
    await V.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vb.x, y: vb.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(800);
    const mcDisp = await H.eval(`document.getElementById('mc').style.display`);
    T('反控闭环 viewer→host 光标标记', mcDisp === 'block', 'mc.style.display=' + mcDisp);
    // iframe 内真实命中:iframe 中心应能 hitAt 到元素(同源 /) — 验证坐标映射端到端没偏
    const hitOk = await H.eval(`(function(){try{var r=document.getElementById('f').getBoundingClientRect();
      var rx=(r.left+r.width/2)/window.innerWidth, ry=(r.top+r.height/2)/window.innerHeight;
      var p=iframePt(rx,ry); var el=p.ok?hitAt(p.x,p.y):null;
      return {ok:p.ok,tag:el?(el.tagName||''):''};}catch(e){return {err:String(e)}}})()`);
    T('iframe 坐标命中(非空)', hitOk && hitOk.ok && hitOk.tag, JSON.stringify(hitOk));
  }

  // 5) 平板触摸套件(CDP Input.dispatchTouchEvent → pointerType=touch;覆盖 v10.3.3 三个触摸修复)
  await H.eval(`(function(){window.__ctrls=[];window.__wheels=[];var w=ws,oldm=w.onmessage;w.onmessage=function(e){if(typeof e.data==='string'){try{var o=JSON.parse(e.data);if(o.t==='ctrl')window.__ctrls.push(o);}catch(x){}}return oldm?oldm.apply(this,arguments):null};var oldF=fire;fire=function(el,t,o){if(t==='wheel'){window.__wheels.push({dx:(o&&o.dx)||0,dy:(o&&o.dy)||0});}return oldF.apply(null,arguments);};return 'ok';})()`);
  const evsOf = async () => (await H.eval(`window.__ctrls.map(function(o){return o.ev})`)) || [];
  const resetCtrl = async () => { await H.eval(`window.__ctrls=[];window.__wheels=[];'ok'`); };
  const tbox = await V.eval(`(function(){var r=cv.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:r.width,h:r.height}})()`);
  T('触摸测试画布可用', !!tbox && tbox.w > 60 && tbox.h > 60, JSON.stringify(tbox));
  if (tbox && tbox.w > 60) {
    // 5a) 抖动点按:10px 抖动仍是 tap(旧阈值8px会误判成拖动→点按失灵)
    await resetCtrl();
    await V.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tbox.x, y: tbox.y }] });
    await sleep(70);
    await V.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tbox.x + 10, y: tbox.y + 10 }] });
    await sleep(70);
    await V.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(800);
    const e1 = await evsOf();
    T('触摸点按(10px抖动)→ click..up 非 release', e1[0] === 'click' && e1[e1.length - 1] === 'up' && e1.indexOf('release') === -1, e1.join(','));
    const mcT = await H.eval(`document.getElementById('mc').style.display`);
    T('触摸点按→ host 光标标记', mcT === 'block', 'mc=' + mcT);

    // 5b) 拖动方向=内容跟手:下拖(位置 dy>0)必须产出 wheel dy<0(旧码同号=页面跟手反跑)
    await resetCtrl();
    const y0 = tbox.y - 40;
    await V.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tbox.x, y: y0 }] });
    for (let i = 1; i <= 6; i++) { await V.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tbox.x, y: y0 + i * 14 }] }); await sleep(50); }
    await V.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(800);
    const e2 = await evsOf();
    const wh = (await H.eval(`window.__wheels`)) || [];
    const sumDy = wh.reduce((s, x) => s + x.dy, 0);
    T('拖动序列 click..move..release', e2[0] === 'click' && e2.indexOf('move') !== -1 && e2[e2.length - 1] === 'release', e2.join(','));
    T('拖动跟手:下拖→wheel dy<0', wh.length > 0 && sumDy < 0, 'wheels=' + wh.length + ' sumDy=' + sumDy);

    // 5c) pointercancel → release(host 松开按下态,不卡拖动)
    await resetCtrl();
    await V.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tbox.x, y: tbox.y - 30 }] });
    await sleep(70);
    await V.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tbox.x, y: tbox.y - 10 }] });
    await sleep(70);
    await V.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await sleep(800);
    const e3 = await evsOf();
    T('pointercancel→ release(松开 host 按下态)', e3.indexOf('move') !== -1 && e3[e3.length - 1] === 'release', e3.join(','));

    // 5d) 鼠标双击→ host 恰好 1 次 dbl(旧码 合成+原生 双发=误触三击选段)
    await sleep(800); // 让触摸合成 dbl 的抑制窗(700ms)过去
    await V.eval(`(function(){window.__pd=0;window.__pm=0;window.__pu=0;window.__dbl=0;
      if(!window.__hook3){window.__hook3=1;
        cv.addEventListener('pointerdown',function(){window.__pd++});
        cv.addEventListener('pointermove',function(){window.__pm++});
        cv.addEventListener('pointerup',function(){window.__pu++});
        cv.addEventListener('dblclick',function(){window.__dbl++});}
      window.__pd=window.__pm=window.__pu=window.__dbl=0;
      window.__sent=[];if(!window.__sw){window.__sw=1;var os=ws.send.bind(ws);ws.send=function(d){try{var o=JSON.parse(d);if(o.t==='ctrl')window.__sent.push(o.ev)}catch(x){}return os(d)}}
      window.__sent=[];return 'hooked';})()`);
    await resetCtrl();
    for (let k = 0; k < 2; k++) {
      await V.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tbox.x, y: tbox.y, button: 'left', buttons: 1, clickCount: k ? 2 : 1 });
      await V.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tbox.x, y: tbox.y, button: 'left', buttons: 0, clickCount: k ? 2 : 1 });
      await sleep(120);
    }
    await sleep(700);
    const e4 = await evsOf();
    const dblN = e4.filter(x => x === 'dbl').length;
    const native = await V.eval(`({pd:window.__pd,pu:window.__pu,dbl:window.__dbl,sent:(window.__sent||[]).join(','),drag:(typeof drag!=='undefined')?JSON.stringify({on:drag.on,id:drag.id,pt:drag.pt,moved:drag.moved}):'?'})`);
    console.log('5d native=' + JSON.stringify(native) + ' hostSeq=' + e4.join(','));
    T('鼠标双击→ host 恰好1次dbl', dblN === 1, 'dbl=' + dblN + ' seq=' + e4.join(',') + ' diag=' + JSON.stringify(native));
  }

  H.close(); V.close();
  chrome.kill();
  await sleep(600);
  try { process.kill(chrome.pid); } catch {}
  console.log(`===== pass=${pass} fail=${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR ' + (e.stack || e.message)); try { chrome && chrome.kill(); } catch {} process.exit(9); });
