'use strict';
/**
 * 内置 DHCP 服务器(纯 Node 零依赖)—— 替代本机已坏死的 ICS(COM 报 0x80040201)
 *
 * 只解决"连热点的设备拿不到 IP"这一个问题:
 *   热点网卡固定 192.168.137.1/24 → 设备连热点 → 本模块分配 192.168.137.x
 *   → 设备访问 http://iflytek.com(:53 已由 dns-server 劫持回 192.168.137.1)
 *   → 伪装门户 → 点 logo 进 /relay 中继站。全程无需 NAT/公网。
 *
 * config.json -> relay.dhcp:
 *   { "enabled": true, "gateway": "192.168.137.1", "mask": "255.255.255.0",
 *     "pool": "192.168.137.2-254", "leaseSec": 3600 }
 *
 * 设计要点:
 *   - 收包绑 0.0.0.0:67(SO_REUSEADDR,防 ICS/WSL 分配器残留占用导致启动失败)
 *   - 发包用定向广播 192.168.137.255:68 —— 由路由表保证从热点网卡发出,
 *     不会污染本机其它网段(家庭 LAN/WSL);中继(giaddr)与续租(ciaddr)按 RFC 单播
 *   - MAC 哈希 → 池内稳定 IP:同一设备几乎永远同一 IP,重启服务/重连热点都不变
 *   - 客户端已选定别的 DHCP 服务器(REQUEST 带 serverId≠本机)时保持沉默,
 *     避免和家里路由器的 DHCP 打架；同时记账到 storage/dhcp-rivals.json
 *     供管理中心体检提示“路由器 DHCP 还在抢答”(教程第1步没做的实证)
 */
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

/* 别的 DHCP 抢答记录器 → storage/dhcp-rivals.json {ip:{t,count}}：
   客户端 REQUEST 点名了别的服务器 = 路由器还在发地址(教程「第1步:改路由器」没做)，
   设备会拿到错网关/错 DNS 导致拦截失效 —— 管理中心体检读它给 [!!] 提示。10s 防抖合并写盘。 */
const rivals = {}; let rivalTimer = null;
function recordRival(srv) {
  try {
    const e = rivals[srv] || { count: 0 };
    e.t = Date.now(); e.count += 1; rivals[srv] = e;
    if (rivalTimer) return;
    rivalTimer = setTimeout(() => {
      rivalTimer = null;
      try {
        const f = path.join(__dirname, 'storage', 'dhcp-rivals.json');
        let disk = {};
        try { disk = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
        for (const k in rivals) disk[k] = { t: rivals[k].t, count: ((disk[k] && disk[k].count) || 0) + rivals[k].count };
        const now = Date.now();
        for (const k in disk) if (now - (disk[k].t || 0) > 30 * 86400000) delete disk[k];
        fs.writeFileSync(f + '.tmp', JSON.stringify(disk));
        fs.renameSync(f + '.tmp', f);
        for (const k in rivals) delete rivals[k];
      } catch {}
    }, 10 * 1000);
    if (rivalTimer.unref) rivalTimer.unref();
  } catch {}
}

/* ---------- 常量 ---------- */
const T = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 };
const MAGIC = 0x63825363; // DHCP magic cookie

let log = () => {};
let D = null;             // 展平后的 relay.dhcp 配置
let sock = null;
let started = false;
const leases = new Map(); // ip字符串 -> { mac, host, until }
const macIp = new Map();  // mac -> ip(稳定映射;重启后按同样哈希天然复原)

/* ---------- IP 工具 ---------- */
function ipToNum(ip) {
  const p = String(ip).split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function numToIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
function ipToBuf(ip) { return Buffer.from(String(ip).split('.').map((n) => parseInt(n, 10))); }
function maskNum(maskStr) { return ipToNum(maskStr) >>> 0; }
function maskBits(maskStr) {
  const n = maskNum(maskStr);
  return n === 0 ? 0 : n.toString(2).replace(/0+$/, '').length;
}
function macStr(macHex) { return macHex.match(/.{2}/g).join(':'); }

/* "192.168.137.2-254" -> { start, end } (uint32) */
function parsePool(str) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/.exec(String(str || '').trim());
  if (!m) return null;
  const start = ipToNum(`${m[1]}.${m[2]}`), end = ipToNum(`${m[1]}.${m[3]}`);
  if (start === null || end === null || start > end) return null;
  return { start, end };
}

/* FNV-1a 32bit:MAC 字节 -> 池内稳定下标 */
function hashMac(macHex) {
  let h = 2166136261 >>> 0;
  for (const b of Buffer.from(macHex, 'hex')) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function inPool(ip) {
  const n = ipToNum(ip);
  return n !== null && n >= D._pool.start && n <= D._pool.end;
}
function inSubnet(ip) {
  const n = ipToNum(ip), gw = ipToNum(D.gateway), m = ipToNum(D.mask);
  return n !== null && gw !== null && m !== null && (n & m) === (gw & m);
}
function isFree(ip, mac) {
  const l = leases.get(ip);
  return !l || l.mac === mac || l.until < Date.now();
}
function grant(ip, mac, host) {
  leases.set(ip, { mac, host: host || '', until: Date.now() + D.leaseSec * 1000 });
  macIp.set(mac, ip);
  return ip;
}
function releaseMac(mac, ip) {
  for (const [k, l] of leases) {
    if (l.mac === mac && (!ip || k === ip)) leases.delete(k);
  }
}
function prune() {
  const now = Date.now();
  for (const [ip, l] of leases) if (l.until < now) leases.delete(ip);
}

/* 分配:优先 ①已有租约 ②客户端点名的可用地址 ③哈希稳定位(被占则顺延探测) */
function allocIp(mac, wantIp, host) {
  const prev = macIp.get(mac);
  if (prev && inPool(prev) && isFree(prev, mac)) return grant(prev, mac, host);
  if (wantIp && inPool(wantIp)) {
    if (isFree(wantIp, mac)) return grant(wantIp, mac, host);
    return null; // 点名地址被别的设备占着 → 回 NAK 让客户端重新 DISCOVER
  }
  if (wantIp) return null; // 点名了池外地址
  const n = D._pool.end - D._pool.start + 1;
  const h = hashMac(mac) % n;
  for (let i = 0; i < n; i++) {
    const ip = numToIp((D._pool.start + ((h + i) % n)) >>> 0);
    if (isFree(ip, mac)) return grant(ip, mac, host);
  }
  return null; // 池满
}

/* ---------- DHCP 报文 ---------- */
/* 解析 BOOTREQUEST。返回 null 表示与本服务器无关/格式不合法 */
function parsePacket(buf) {
  if (buf.length < 240) return null;
  if (buf[0] !== 1) return null; // 只收 BOOTREQUEST
  if (buf.readUInt32BE(236) !== MAGIC) return null;
  const macHex = buf.subarray(28, 34).toString('hex');
  if (/^0{12}$/.test(macHex)) return null;
  const msg = {
    xid: buf.readUInt32BE(4),
    flags: buf.readUInt16BE(10),
    ciaddr: numToIp(buf.readUInt32BE(12)),
    giaddr: numToIp(buf.readUInt32BE(24)),
    macHex,
    type: 0, reqIp: null, serverId: null, host: '',
  };
  let off = 240;
  while (off < buf.length) {
    const code = buf[off];
    if (code === 0) { off += 1; continue; } // pad
    if (code === 255) break;                // end
    const len = buf[off + 1];
    if (off + 2 + len > buf.length) break;
    const val = buf.subarray(off + 2, off + 2 + len);
    if (code === 53 && len >= 1) msg.type = val[0];
    else if (code === 50 && len === 4) msg.reqIp = numToIp(val.readUInt32BE(0));
    else if (code === 54 && len === 4) msg.serverId = numToIp(val.readUInt32BE(0));
    else if (code === 12) msg.host = val.toString('utf8').replace(/[^\x20-\x7e]/g, '').slice(0, 32);
    off += 2 + len;
  }
  return msg.type ? msg : null;
}

/* 构造 BOOTREPLY */
function buildReply(req, type, yiaddr) {
  const inform = type === T.ACK && req.type === T.INFORM;
  const gwNum = ipToNum(D.gateway) >>> 0;
  const head = Buffer.alloc(240);
  head[0] = 2;                  // op = BOOTREPLY
  head[1] = 1; head[2] = 6;     // htype=以太网, hlen=6
  head.writeUInt32BE(req.xid, 4);
  head.writeUInt16BE(req.flags, 10);
  if (!inform && req.ciaddr !== '0.0.0.0') head.writeUInt32BE(ipToNum(req.ciaddr) >>> 0, 12); // ciaddr
  if (!inform && yiaddr) head.writeUInt32BE(ipToNum(yiaddr) >>> 0, 16);                       // yiaddr
  head.writeUInt32BE(gwNum, 20);                                                              // siaddr
  if (req.giaddr !== '0.0.0.0') head.writeUInt32BE(ipToNum(req.giaddr) >>> 0, 24);            // giaddr
  Buffer.from(req.macHex, 'hex').copy(head, 28);                                              // chaddr 前 6 字节
  head.writeUInt32BE(MAGIC, 236);

  const opts = [
    Buffer.from([53, 1, type]),              // DHCP 消息类型
    Buffer.from([54, 4]), ipToBuf(D.gateway), // server-id = 192.168.137.1
  ];
  if (!inform) {                              // 租期(INFORM 不带)
    const lb = Buffer.alloc(4);
    lb.writeUInt32BE(D.leaseSec >>> 0);
    opts.push(Buffer.from([51, 4]), lb);
  }
  opts.push(
    Buffer.from([1, 4]), ipToBuf(D.mask),     // 子网掩码
    Buffer.from([3, 4]), ipToBuf(D.gateway),  // 路由器 = 网关
    Buffer.from([6, 4]), ipToBuf(D.gateway),  // DNS = 本机 sinkhole
    Buffer.from([28, 4]), ipToBuf(D._broadcast), // 广播地址
    Buffer.from([255])
  );
  return Buffer.concat([head, ...opts]);
}

/* 发送:giaddr→单播中继;ciaddr→单播续租;其余→定向广播(保证走热点网卡) */
function sendReply(buf, req) {
  try {
    if (req.giaddr !== '0.0.0.0') sock.send(buf, 67, req.giaddr);
    else if (req.ciaddr !== '0.0.0.0') sock.send(buf, 68, req.ciaddr);
    else sock.send(buf, 68, D._broadcast);
  } catch (e) { log(`[DHCP] 发送失败: ${e.message}`); }
}

/* ---------- 请求处理 ---------- */
function handleMessage(buf /* , rinfo */) {
  try {
    const p = parsePacket(buf);
    if (!p) return;
    // 中继(giaddr)转发的请求只服务本网段(网关/掩码之外的 giaddr 一律不理)
    if (p.giaddr !== '0.0.0.0' && !inSubnet(p.giaddr)) return;
    const who = `${macStr(p.macHex)}${p.host ? ` "${p.host}"` : ''}`;

    switch (p.type) {
      case T.DISCOVER: {
        const ip = allocIp(p.macHex, null, p.host);
        if (!ip) { log(`[DHCP] DISCOVER ${who} 地址池满,不响应`); return; }
        log(`[DHCP] DISCOVER ${who} → OFFER ${ip}`);
        sendReply(buildReply(p, T.OFFER, ip), p);
        break;
      }
      case T.REQUEST: {
        if (p.serverId && p.serverId !== D.gateway) { // 客户端选了别的服务器 → 沉默
          log(`[DHCP] REQUEST ${who} 已选他方服务器 ${p.serverId},忽略`);
          recordRival(p.serverId); // 记账：体检据此提示“路由器 DHCP 还在抢答”
          return;
        }
        const want = p.reqIp || (p.ciaddr !== '0.0.0.0' ? p.ciaddr : null);
        const ip = allocIp(p.macHex, want, p.host);
        if (!ip) {
          log(`[DHCP] REQUEST ${who} 无法满足(${want || '池满'}) → NAK`);
          sendReply(buildReply(p, T.NAK, null), p);
          return;
        }
        log(`[DHCP] REQUEST ${who} → ACK ${ip}${p.serverId ? '' : ' (续租)'}`);
        sendReply(buildReply(p, T.ACK, ip), p);
        break;
      }
      case T.DECLINE: {
        if (p.reqIp) leases.delete(p.reqIp);
        log(`[DHCP] DECLINE ${who} ${p.reqIp || ''}(地址冲突,已回收)`);
        break;
      }
      case T.RELEASE: {
        releaseMac(p.macHex, p.ciaddr !== '0.0.0.0' ? p.ciaddr : null);
        log(`[DHCP] RELEASE ${who} ${p.ciaddr !== '0.0.0.0' ? p.ciaddr : ''}`);
        break;
      }
      case T.INFORM: {
        log(`[DHCP] INFORM ${who} → ACK(只发参数)`);
        sendReply(buildReply(p, T.ACK, null), p);
        break;
      }
      default: break;
    }
  } catch (e) {
    log(`[DHCP][ERR] ${e.stack || e}`);
  }
}
/* ---------- 启动 ---------- */
function start(config, logger) {
  log = logger || log;
  const raw = (config && config.relay && config.relay.dhcp) || {};
  if (raw.enabled === false || started) return;
  const gateway = raw.gateway || '192.168.137.1';
  const mask = raw.mask || '255.255.255.0';
  const pool = parsePool(raw.pool || '192.168.137.2-254');
  if (!pool || ipToNum(gateway) === null || maskNum(mask) === null) {
    log('[DHCP] relay.dhcp 配置不合法,未启动'); return;
  }
  const mn = maskNum(mask);
  D = {
    gateway,
    mask,
    leaseSec: Math.max(60, parseInt(raw.leaseSec, 10) || 3600),
    _pool: pool,
    _broadcast: numToIp(((ipToNum(gateway) & mn) | (~mn >>> 0)) >>> 0),
  };

  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', handleMessage);
  sock.on('error', (e) => log(`[DHCP] socket 错误: ${e.message}`));
  sock.bind(67, '0.0.0.0', () => {
    sock.setBroadcast(true);
    started = true;
    log(`[DHCP] DHCP 服务已启动 UDP:67 — 网关 ${D.gateway}/${maskBits(D.mask)} 广播 ${D._broadcast} 池 ${numToIp(D._pool.start)}-${numToIp(D._pool.end)} 租期 ${D.leaseSec}s`);
  });
  setInterval(prune, 60 * 1000).unref();
}

module.exports = { start, recordRival }; // recordRival 供自测直驱

/* 直接运行做本机自测: runtime\node.exe dhcp-server.js --selftest (仅启动服务端打印日志) */
if (require.main === module) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  start(cfg, (m) => console.log(m));
  console.log('DHCP selftest 服务端已启动(等待客户端包,直接跑 test-dhcp.js 更完整)');
}
