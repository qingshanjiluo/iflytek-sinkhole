// 投屏协议 E2E:起测试 relay(28799) → host/view 双客户端 → 验证 二进制帧转发 / ctrl 回传 / viewer 超限踢 / host 掉线通知
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const base = require(path.join(__dirname, 'config.json'));
base.relay = Object.assign({}, base.relay, { port: 28799, host: '127.0.0.1' });

function wsClient(role) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(28799, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const c = { sock, buf: Buffer.alloc(0), msgs: [], bins: [], closed: false, join: null };
    sock.on('connect', () => {
      sock.write(`GET /ws/cast?role=${role} HTTP/1.1\r\nHost: 127.0.0.1:28799\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
    });
    sock.on('error', () => { c.closed = true; });
    sock.on('close', () => { c.closed = true; });
    sock.on('data', d => {
      if (!c.join) {
        c.buf = Buffer.concat([c.buf, d]);
        const s = c.buf.toString('latin1');
        const i = s.indexOf('\r\n\r\n');
        if (i === -1) return;
        if (!s.startsWith('HTTP/1.1 101')) return reject(new Error('no 101: ' + s.slice(0, 60)));
        c.join = true;
        resolve(c);
        d = c.buf.subarray(i + 4); // 剩余可能是帧
        c.buf = Buffer.alloc(0);
        if (!d.length) return;
      }
      // 解帧(服务器帧不带掩码)
      c.buf = Buffer.concat([c.buf, d]);
      let b = c.buf;
      while (b.length >= 2) {
        const op = b[0] & 0x0f;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
        if (b.length < off + len) break;
        const payload = b.subarray(off, off + len);
        b = b.subarray(off + len);
        if (op === 1) { try { c.msgs.push(JSON.parse(payload.toString('utf8'))); } catch {} }
        else if (op === 2) c.bins.push(Buffer.from(payload));
      }
      c.buf = b;
    });
    c.send = obj => sock.write(frame(Buffer.from(JSON.stringify(obj))));
    c.sendBin = buf => sock.write(frame(buf, 2));
    setTimeout(() => reject(new Error('handshake timeout')), 4000);
  });
}
function frame(payload, op) {
  op = op || 1;
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
  else if (len <= 65535) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const p = Buffer.from(payload);
  for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, p]);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function T(name, cond) { if (cond) { pass++; console.log('ok ' + name); } else { fail++; console.log('FAIL ' + name); } }

require(path.join(__dirname, 'relay-site.js')).start(base, m => console.log('SRV ' + m)).then(async port => {
  T('relay listen 28799', port === 28799);
  const host = await wsClient('host');
  T('host 101', true);
  const view = await wsClient('view');
  T('view 101', true);
  await sleep(150);
  T('view got state(host=1)', view.msgs.some(m => m.t === 'state' && m.host === true));
  T('host got vcount=1', host.msgs.some(m => m.t === 'vcount' && m.n === 1));

  // 1) 帧转发:host 二进制 → view
  const jpeg = crypto.randomBytes(64 * 1024);
  host.sendBin(jpeg);
  await sleep(200);
  T('view got host frame', view.bins.length === 1 && view.bins[0].length === jpeg.length && view.bins[0].equals(jpeg));

  // 2) ctrl 回传:view → host
  view.send({ t: 'ctrl', ev: 'click', rx: 0.5, ry: 0.25 });
  await sleep(150);
  T('host got ctrl', host.msgs.some(m => m.t === 'ctrl' && m.ev === 'click' && m.rx === 0.5 && m.ry === 0.25));

  // 3) nav 广播:view 导航 → host 收 nav + view 收 state
  view.send({ t: 'nav', url: 'https://www.qq.com/' });
  await sleep(150);
  T('host got nav', host.msgs.some(m => m.t === 'nav' && m.url === 'https://www.qq.com/'));
  T('view got state(url)', view.msgs.some(m => m.t === 'state' && m.url === 'https://www.qq.com/'));

  // 4) viewer 发 >8KB 控制帧 → 服务端踢人(view cap 8KB)
  const big = crypto.randomBytes(16 * 1024);
  view.sendBin(big);
  await sleep(300);
  T('view kicked on >8KB', view.closed === true);
  T('host vcount 0 after kick', host.msgs.some(m => m.t === 'vcount' && m.n === 0));

  // 5) host 断线 → 验证 hostoff(先发规范 close 帧=浏览器 tab 关闭的真实路径,再 destroy 兜底)
  const view2 = await wsClient('view');
  await sleep(150);
  const before = view2.msgs.length;
  host.sock.write(frame(Buffer.from([0x03, 0xe8]), 8)); // close frame, payload=1000
  await sleep(600);
  if (!view2.msgs.some(m => m.t === 'hostoff')) host.sock.destroy();
  await sleep(600);
  T('view2 got hostoff', view2.msgs.some(m => m.t === 'hostoff'));
  if (fail) console.log('DEBUG msgsAfter=' + JSON.stringify(view2.msgs.slice(before)) + ' srvLogWillShowAbove');

  host.sock.destroy(); view2.sock.destroy();
  console.log(`===== pass=${pass} fail=${fail} =====`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}).catch(e => { console.log('FAIL starter: ' + e.message); process.exit(2); });
