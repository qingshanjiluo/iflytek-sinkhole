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

  H.close(); V.close();
  chrome.kill();
  await sleep(600);
  try { process.kill(chrome.pid); } catch {}
  console.log(`===== pass=${pass} fail=${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR ' + (e.stack || e.message)); try { chrome && chrome.kill(); } catch {} process.exit(9); });
