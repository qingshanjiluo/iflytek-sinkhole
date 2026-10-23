// 平板身份(非本机)鉴权链路 E2E——模式1/2 的真实入口体验:
// 平板 → /cast 无会话必须 302 到登录(带 next=/cast) → 登录(表单/JSON)拿 relay_sid → 回 /cast 200
// → 带 cookie 的 /ws/cast 握手 101;无会话 WS 必须 401;next 开放重定向必须被 safeNext 拦掉。
// 身份模拟: clientIp 优先取 X-Forwarded-For → 请求头带 192.168.137.69(假想平板),本机管理员豁免即失效。
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const base = require(path.join(__dirname, 'config.json'));
base.relay = Object.assign({}, base.relay, { port: 28799, host: '127.0.0.1' });
const TABLET = '192.168.137.69';
const SESS = path.join(__dirname, 'storage', 'sessions.json');
const SESS_BACKUP = fs.existsSync(SESS) ? fs.readFileSync(SESS) : null;

let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('ok ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); } }

function req(opt, body) {
  return new Promise((res, rej) => {
    const r = http.request(opt, (rs) => {
      let b = '';
      rs.on('data', d => b += d);
      rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body: b }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}
const H = (extra) => Object.assign({ Host: '127.0.0.1:28799', 'X-Forwarded-For': TABLET }, extra || {});

// 最小 WS 握手:返回 {ok101, raw} —— 不解析后续帧
function wsHandshake(pathname, headers) {
  return new Promise((resolve) => {
    const sock = net.connect(28799, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.on('connect', () => {
      const lines = [`GET ${pathname} HTTP/1.1`, 'Host: 127.0.0.1:28799', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`];
      for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${v}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    sock.on('data', d => { const s = d.toString('latin1'); finish(s.slice(0, 40)); });
    sock.on('error', () => finish('ERR'));
    sock.on('close', () => finish('CLOSE'));
    setTimeout(() => finish('TIMEOUT'), 4000);
  });
}

(async () => {
  const user = Object.keys(base.relay.auth.accounts)[0];
  const pw = base.relay.auth.accounts[user];
  if (!user || !pw) { console.log('BLOCKED no auth account in config'); process.exit(2); }
  T('config auth.enabled', base.relay.auth.enabled === true);

  const port = await require(path.join(__dirname, 'relay-site.js')).start(base, m => console.log('SRV ' + m));
  T('relay listen 28799', port === 28799);
  const P = { host: '127.0.0.1', port: 28799 };

  // 1) 平板无会话访问 /cast → 302 登录, next=本路径(模式2 入口必须先登录)
  let r = await req({ ...P, path: '/cast', method: 'GET', headers: H(), });
  T('/cast 无会话 → 302', r.status === 302, 'got ' + r.status);
  const loc = r.headers.location || '';
  T('location 指向登录且带 next=/cast', /^\/auth\/login\?next=%2Fcast$/.test(loc), loc);

  // 2) 平板无会话 WS /ws/cast → 401(不能建连)
  const w1 = await wsHandshake('/ws/cast?role=view', { 'X-Forwarded-For': TABLET });
  T('WS 无会话 → 401 拒绝', /^HTTP\/1\.1 401/.test(w1 || ''), w1);

  // 3) 模式1 入口 /p/ 同样受保护
  r = await req({ ...P, path: '/p/' + encodeURIComponent('http://example.com/'), method: 'GET', headers: H() });
  T('/p/ 无会话 → 302 登录', r.status === 302, 'got ' + r.status);

  // 4) 登录(JSON) 正确密码 → relay_sid + next=/cast
  r = await req({ ...P, path: '/api/auth/login', method: 'POST', headers: H({ 'Content-Type': 'application/json' }) },
    JSON.stringify({ user, password: pw, next: '/cast' }));
  T('登录 200', r.status === 200, 'got ' + r.status + ' ' + r.body.slice(0, 80));
  let j = {}; try { j = JSON.parse(r.body); } catch {}
  T('登录返回 next=/cast', j.next === '/cast', JSON.stringify(j));
  const sc = String(r.headers['set-cookie'] || '');
  const sid = (/relay_sid=([0-9a-f]{32})/.exec(sc) || [])[1];
  T('拿到 relay_sid cookie', !!sid, sc.slice(0, 60));
  const CK = `relay_sid=${sid}`;

  // 5) 带 cookie 平板身份 → /cast 200 且是观看页
  r = await req({ ...P, path: '/cast', method: 'GET', headers: H({ Cookie: CK }) });
  T('/cast 带会话 → 200', r.status === 200, 'got ' + r.status);
  T('/cast 是观看页(含 ws/cast)', r.body.indexOf('/ws/cast?role=view') !== -1, 'len=' + r.body.length);

  // 6) 带 cookie WS → 101
  const w2 = await wsHandshake('/ws/cast?role=view', { 'X-Forwarded-For': TABLET, Cookie: CK });
  T('WS 带会话 → 101', /^HTTP\/1\.1 101/.test(w2 || ''), w2);

  // 7) 错误密码 → 401
  r = await req({ ...P, path: '/api/auth/login', method: 'POST', headers: H({ 'Content-Type': 'application/json' }) },
    JSON.stringify({ user, password: pw + '_wrong', next: '/cast' }));
  T('错误密码 → 401', r.status === 401, 'got ' + r.status);

  // 8) next 开放重定向防护(safeNext 拦 //evil)
  r = await req({ ...P, path: '/api/auth/login', method: 'POST', headers: H({ 'Content-Type': 'application/json' }) },
    JSON.stringify({ user, password: pw, next: '//evil.example' }));
  j = {}; try { j = JSON.parse(r.body); } catch {}
  T('safeNext 拦开放重定向 → /relay', r.status === 200 && j.next === '/relay', JSON.stringify(j));

  console.log(`===== pass=${pass} fail=${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR ' + (e.stack || e.message)); process.exit(9); })
  .finally(() => {
    // 还原 sessions.json,不污染活服务的会话库
    try {
      if (SESS_BACKUP) fs.writeFileSync(SESS, SESS_BACKUP);
      else if (fs.existsSync(SESS)) fs.unlinkSync(SESS);
      console.log('sessions.json restored');
    } catch (e) { console.log('restore fail: ' + e.message); }
  });
