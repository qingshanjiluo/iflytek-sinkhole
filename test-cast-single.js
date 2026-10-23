// 单页复现:headless chrome 只开 /cast,7 秒后 dump DOM(读 pill 终态) + console 日志;服务端有握手时代日志对照
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const RELAY = 'http://127.0.0.1:28799';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(url) { return new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej); }); }
(async () => {
  try { await get(RELAY + '/api/info'); } catch { console.log('BLOCKED relay down'); process.exit(2); }
  const ws = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
    '--user-data-dir=C:\\Windows\\Temp\\cdp-single', '--remote-debugging-port=9344', RELAY + '/cast'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(500);
    try { const l = await get('http://127.0.0.1:9344/json/list'); target = l.find(t => t.type === 'page' && /\/cast$/.test(t.url || '')); } catch {}
  }
  if (!target) { console.log('no target'); ws.kill(); process.exit(3); }
  // 极简 CDP(直接复用 node ws 手写太长;这里用 Page.captureSnapshot 不行,改用 Runtime.evaluate 需要 ws —— 用 /json 无法 eval。
  // 折衷:用 --virtual-time-budget 第二进程 dump-dom。
  ws.kill();
  await sleep(300);
  const dump = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-proxy-server',
    '--user-data-dir=C:\\Windows\\Temp\\cdp-single2', '--virtual-time-budget=7000',
    '--enable-logging=stderr', '--dump-dom', RELAY + '/cast'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let dom = '', err = '';
  dump.stdout.on('data', d => dom += d);
  dump.stderr.on('data', d => err += d);
  const done = new Promise(r => dump.on('close', r));
  await Promise.race([done, sleep(25000)]);
  const pill = /id="stP"[^>]*>([^<]*)</.exec(dom);
  const ph = /id="phT"[^>]*>([^<]*)</.exec(dom);
  console.log('pill=' + (pill ? pill[1] : '?') + ' phT=' + (ph ? ph[1] : '?') + ' domLen=' + dom.length);
  const cerr = err.split(/\r?\n/).filter(l => /ERROR:CONSOLE|Uncaught|WebSocket|CONSOLE/.test(l)).slice(0, 10);
  console.log('console=' + (cerr.length ? cerr.map(l => l.slice(0, 160)).join(' || ') : 'clean'));
  try { dump.kill(); } catch {}
  try { ws.kill(); } catch {}
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); process.exit(9); });
