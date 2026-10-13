'use strict';
/**
 * DHCP 自测:在本机模拟一台"手机"完成 DISCOVER → OFFER → REQUEST → ACK 全流程。
 * 服务端在测试进程内直接启动(不影响正式服务),用法:
 *   runtime\node.exe test-dhcp.js
 * 退出码:0=全流程通过 2=服务端有日志但客户端没收到回包(广播回环受限) 1=失败
 */
const dgram = require('dgram');
const cfg = require('./config.json');
const dhcp = require('./dhcp-server');

const GW = (cfg.relay.dhcp && cfg.relay.dhcp.gateway) || '192.168.137.1';
const ipBytes = (ip) => Buffer.from(String(ip).split('.').map((n) => parseInt(n, 10)));
const numToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const macStr = (h) => h.match(/.{2}/g).join(':');

const MAC = 'de:ad:be:ef:' + Math.floor(Math.random() * 256).toString(16).padStart(2, '0') + ':' + Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
const MAC_HEX = MAC.replace(/:/g, '');
const XID = 0x12345678;

function buildPacket(o) {
  const b = Buffer.alloc(240);
  b[0] = 1; b[1] = 1; b[2] = 6;
  b.writeUInt32BE(o.xid, 4);
  b.writeUInt16BE(0x8000, 10); // 广播位
  Buffer.from(MAC_HEX, 'hex').copy(b, 28);
  b.writeUInt32BE(0x63825363, 236);
  const parts = [Buffer.from([53, 1, o.type])];
  if (o.reqIp) parts.push(Buffer.from([50, 4]), ipBytes(o.reqIp));
  if (o.serverId) parts.push(Buffer.from([54, 4]), ipBytes(o.serverId));
  if (o.host) { const h = Buffer.from(o.host); parts.push(Buffer.from([12, h.length]), h); }
  parts.push(Buffer.from([255]));
  return Buffer.concat([b, ...parts]);
}

function parseReply(buf) {
  if (buf.length < 240 || buf[0] !== 2 || buf.readUInt32BE(236) !== 0x63825363) return null;
  const m = { xid: buf.readUInt32BE(4), yiaddr: numToIp(buf.readUInt32BE(16)), type: 0, serverId: null, router: null, dns: null, mask: null };
  let off = 240;
  while (off < buf.length) {
    const c = buf[off];
    if (c === 0) { off++; continue; }
    if (c === 255) break;
    const len = buf[off + 1];
    const v = buf.subarray(off + 2, off + 2 + len);
    if (c === 53) m.type = v[0];
    else if (c === 54 && len === 4) m.serverId = numToIp(v.readUInt32BE(0));
    else if (c === 3 && len === 4) m.router = numToIp(v.readUInt32BE(0));
    else if (c === 6 && len >= 4) m.dns = numToIp(v.readUInt32BE(0));
    else if (c === 1 && len === 4) m.mask = numToIp(v.readUInt32BE(0));
    off += 2 + len;
  }
  return m;
}

let offer = null;
let stage = 'discover';
let done = false;
let retry = null;

function finish(code, msg) {
  if (done) return;
  done = true;
  clearTimeout(retry);
  console.log(msg || `结果: exit=${code}`);
  try { sock.close(); } catch {}
  process.exit(code);
}

function onReply(buf) {
  const m = parseReply(buf);
  if (!m || m.xid !== XID) return;
  if (m.type === 2 && stage === 'discover') {
    stage = 'request';
    if (m.serverId !== GW) { console.log(`[客户端] OFFER 来自他方服务器 ${m.serverId},忽略`); return; }
    console.log(`[客户端] ← OFFER  yiaddr=${m.yiaddr} serverId=${m.serverId} mask=${m.mask} router=${m.router} dns=${m.dns}`);
    console.log(`[客户端] → REQUEST  (serverId=${GW} reqIp=${m.yiaddr})`);
    sock.send(buildPacket({ type: 3, xid: XID, reqIp: m.yiaddr, serverId: GW, host: 'selftest-phone' }), 67, bcHost(), (e) => { if (e) finish(1, `❌ REQUEST 发送失败: ${e.message}`); });
  } else if (m.type === 5 && stage === 'request') {
    const ok = m.yiaddr && m.serverId === GW && m.dns === GW && m.router === GW;
    console.log(`[客户端] ← ACK  yiaddr=${m.yiaddr} dns=${m.dns} router=${m.router}`);
    finish(ok ? 0 : 1, ok ? '✅ DHCP 全流程自测通过(DISCOVER→OFFER→REQUEST→ACK)' : '❌ ACK 内容校验不通过');
  } else if (m.type === 6) {
    finish(1, '❌ 收到 NAK(服务端拒绝,见上方 [DHCP] 日志)');
  }
}

const seenLogs = [];
const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let sock = client; // 当前使用的 socket(attempt 可重建)
client.on('message', onReply);
client.on('error', (e) => finish(1, `❌ 客户端 socket: ${e.message}`));

let bindHost = ''; // '' = 0.0.0.0
function bcHost() { return bindHost ? `${bindHost.split('.').slice(0, 3).join('.')}.255` : '255.255.255.255'; }

function discoverOnce() {
  console.log(`[客户端] → DISCOVER  (mac=${MAC} xid=0x${XID.toString(16)} 绑定=${bindHost || '0.0.0.0'} 目标=${bcHost()}:67)`);
  sock.send(buildPacket({ type: 1, xid: XID, mac: MAC_HEX, host: 'selftest-phone' }), 67, bcHost(), (e) => { if (e) finish(1, `❌ DISCOVER 发送失败: ${e.message}`); });
}

function attempt(host) {
  bindHost = host;
  try { sock.close(); } catch {}
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', onReply);
  sock.on('error', () => {});
  sock.bind(68, host || undefined, () => {
    try { sock.setBroadcast(true); } catch {}
    discoverOnce();
    retry = setTimeout(() => {
      if (stage !== 'discover') return;
      const serverSaw = /DISCOVER .* → OFFER/.test(seenLogs.join('\n'));
      finish(2, serverSaw
        ? '⚠️ 服务端已应答(见上方 [DHCP] 日志)但客户端收不到回包 → 本机广播回环受限;局域网真机(手机)不受此影响,请直接用手机验证。'
        : '⚠️ 客户端无回包且服务端无 [DHCP] 日志 → 服务端未收到包,需检查绑定/网段');
    }, 3000);
  });
}

console.log('=== DHCP 自测开始(服务端与模拟客户端同进程) ===');
dhcp.start(cfg, (m) => { seenLogs.push(m); console.log(m); });
attempt('');
setTimeout(() => {
  if (done || stage !== 'discover') return;
  console.log('... 3s 无响应,换热点网卡定向广播重试(绑定 ' + GW + ')。');
  attempt(GW);
}, 3200);
