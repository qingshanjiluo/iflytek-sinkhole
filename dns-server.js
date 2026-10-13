'use strict';
/**
 * 轻量 DNS 拦截(Sinkhole)服务器 —— 零第三方依赖
 * - 命中 sinkholeDomain(及其可选子域)的查询:直接应答 A 记录 = answerIP
 * - 其余查询:原始报文转发给上游 DNS 并回传(超时自动切换下一个上游)
 * - 支持 UDP + TCP(53 端口),仅响应允许网段(可配置)
 */
const dgram = require('dgram');
const net = require('net');
const os = require('os');

const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_ANY = 255;

let cfg = null;
let log = () => {};

/* ---------- 本机网卡自动探测(换电脑免配置) ---------- */
let ifList = []; // { name, ip, num, mask }
function refreshIfaces() {
  const list = [];
  const nis = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nis)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const num = ipToNum(a.address), mask = ipToNum(a.netmask);
      if (num === null || mask === null) continue;
      list.push({ name, ip: a.address, num, mask });
    }
  }
  ifList = list;
}
// 需要跟踪的接口:排除 Hyper-V/WSL 虚拟交换机(它们随 WSL 起停高频变化,不能作为指纹)
const VIRTUAL_IF = /^(vEthernet|Loopback|Bluetooth|Teredo|isatap|WFP)/i;
function realIfs() { return ifList.filter((f) => !VIRTUAL_IF.test(f.name)); }

// 网卡/网段指纹变化时主动重绑(热点开关、插拔网卡 → 本机成为各地址最后绑定者)
function refreshWatch() {
  const before = ifKey;
  refreshIfaces();
  const key = realIfs().map((f) => f.name + f.ip).join('|');
  if (key === before) return;
  ifKey = key;
  if (before && udpSocks.length) bindAllUdp('网卡/网段变化');
}
// 主要局域网 IP(排除虚拟网卡),作为兜底应答
function primaryIP() {
  const pref = ifList.find((f) => !/^(vEthernet|Loopback|Bluetooth)/i.test(f.name));
  return (pref || ifList[0] || {}).ip || '';
}
// 查询来源命中哪个本机网段,就回那个网段上的本机 IP(内网回内网IP,热点回热点IP)
function ourIpFor(src) {
  const sn = ipToNum(src);
  if (sn === null) return null;
  const hit = ifList.find((f) => (sn & f.mask) === (f.num & f.mask));
  return hit ? hit.ip : null;
}

/* ---------- 工具 ---------- */

function ipToBuf(ip) {
  return Buffer.from(ip.split('.').map((n) => parseInt(n, 10)));
}

function normalizeAddr(addr) {
  // 把 ::ffff:1.2.3.4 / ::1 这类形式归一成 IPv4 字符串
  if (!addr) return '';
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') addr = '127.0.0.1';
  return addr;
}

function ipToNum(ip) {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function addrAllowed(addr) {
  const src = normalizeAddr(addr);
  if (src === '127.0.0.1' || src === '') return src === '127.0.0.1';
  const ipn = ipToNum(src);
  if (ipn === null) return false; // IPv6 直连等,不在白名单
  // Hyper-V/WSL 虚拟网段(调试与容器内客户端)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(src)) return true;
  // 显式配置优先;留空则自动 = 本机所有网卡网段都放行(换电脑免配置)
  const list = cfg.allowFromCIDR;
  if (list && list.length > 0) return list.some((cidr) => cidrMatch(src, cidr));
  return ifList.some((f) => (ipn & f.mask) === (f.num & f.mask));
}

function matchesSinkhole(name) {
  const d = (cfg.sinkholeDomain || '').toLowerCase();
  if (d && name === d) return true;
  if (d && !!cfg.blockSubdomains && name.endsWith('.' + d)) return true;
  // 额外劫持列表(如手机/系统的联网检测域名 → 让设备显示"已连接")
  const extra = cfg.sinkExtraDomains;
  if (Array.isArray(extra) && extra.length) {
    for (const e of extra) {
      const n = String(e || '').toLowerCase().trim();
      if (!n) continue;
      if (name === n) return true;
      if (n.startsWith('*.') && name.endsWith(n.slice(1))) return true;
    }
  }
  return false;
}

function cidrMatch(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const bn = ipToNum(base);
  const n = ipToNum(ip);
  if (bn === null || n === null || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (bn & mask);
}

// 应答 IP 选择:1) 显式网段映射 2) 查询来源落在本机哪个网段就回哪个网段的接口 IP
// 3) 配置 answerIP 4) 主要局域网 IP 兜底 —— 全程自动,拷到别的电脑无需改配置
function pickAnswerIP(srcAddr) {
  const src = normalizeAddr(srcAddr);
  const map = cfg.answerBySource;
  if (map) {
    for (const [cidr, ip] of Object.entries(map)) {
      if (cidrMatch(src, cidr)) return ip;
    }
  }
  return ourIpFor(src) || cfg.answerIP || primaryIP();
}

/* ---------- DNS 报文 ---------- */

function parseQuestionName(buf, offset) {
  const labels = [];
  let i = offset;
  while (i < buf.length) {
    const len = buf[i];
    if (len === 0) { i += 1; break; }
    if ((len & 0xc0) === 0xc0) i += 2; // 防御:指针(问题段正常不出现)
    else if (i + 1 + len <= buf.length) {
      labels.push(buf.slice(i + 1, i + 1 + len).toString('latin1'));
      i += 1 + len;
    } else return null;
  }
  if (i + 4 > buf.length) return null;
  return { name: labels.join('.').toLowerCase(), qnameEnd: i };
}

function makeResponse(query, questionEnd, answers) {
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2); // 事务 ID
  const qflags = query.readUInt16BE(2);
  header.writeUInt16BE(0x8000 | (qflags & 0x0100) | 0x0080, 2); // QR=1 + 保留RD + RA=1
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  const parts = [header, query.slice(12, questionEnd)]; // 问题段原样复制
  for (const a of answers) {
    const rr = Buffer.alloc(12); // NAME(2)+TYPE(2)+CLASS(2)+TTL(4)+RDLENGTH(2)
    rr.writeUInt16BE(0xc00c, 0); // NAME -> 指针,指向问题段(offset 12)
    rr.writeUInt16BE(a.type, 2);
    rr.writeUInt16BE(1, 4); // CLASS = IN
    rr.writeUInt32BE(a.ttl, 6);
    rr.writeUInt16BE(a.data.length, 10);
    parts.push(rr, a.data);
  }
  return Buffer.concat(parts);
}

/* ---------- 核心处理 ---------- */

function handleDns(msg, rinfo, send) {
  if (msg.length < 17) return;
  const qflags = msg.readUInt16BE(2);
  if (qflags & 0x8000) return; // 收到的不是查询,忽略
  if (msg.readUInt16BE(4) !== 1) { // 多问题查询:直接转发
    return forwardUpstream(msg, rinfo, send);
  }
  const q = parseQuestionName(msg, 12);
  if (!q) return forwardUpstream(msg, rinfo, send);

  if (matchesSinkhole(q.name)) {
    const qtype = msg.readUInt16BE(q.qnameEnd);
    const questionEnd = q.qnameEnd + 4;
    const ansIP = pickAnswerIP(rinfo.address);
    let answers = [];
    if ((qtype === TYPE_A || qtype === TYPE_ANY) && ansIP) {
      answers = [{ type: TYPE_A, ttl: 30, data: ipToBuf(ansIP) }];
    }
    // AAAA 及其它类型:回 NOERROR 零应答,客户端自然回落 IPv4
    send(makeResponse(msg, questionEnd, answers));
    const quiet = rinfo.port === PROBE_PORT; // 看门狗探针不记日志
    if (!quiet) log(`[DNS][SINK] ${q.name} type=${qtype} from ${rinfo.address} -> ${answers.length ? ansIP : '(empty)'}`);
  } else {
    forwardUpstream(msg, rinfo, send);
  }
}

/* ---------- 上游转发 ---------- */

const upSocket = dgram.createSocket('udp4');
const pending = new Map(); // key: "id|clientIp|clientPort" -> { send, i, timer, msg }

function forwardUpstream(msg, rinfo, send) {
  const key = `${msg.readUInt16BE(0)}|${rinfo.address}|${rinfo.port}`;
  if (pending.has(key)) return; // 同一客户端同 ID 查询在途,忽略重复
  const entry = { send, i: 0, timer: null, msg };
  pending.set(key, entry);
  const tryNext = () => {
    if (!pending.has(key)) return;
    if (entry.i >= cfg.upstreamDNS.length) {
      pending.delete(key); // 全部上游超时,丢弃(客户端会重试)
      return;
    }
    const [host, port] = cfg.upstreamDNS[entry.i].split(':');
    entry.i += 1;
    upSocket.send(entry.msg, parseInt(port || '53', 10), host, (err) => {
      if (err) tryNext();
    });
    entry.timer = setTimeout(tryNext, 1500);
  };
  tryNext();
}

upSocket.on('message', (msg, r) => {
  const id = msg.readUInt16BE(0);
  for (const [key, entry] of pending) {
    if (key.startsWith(`${id}|`)) {
      clearTimeout(entry.timer);
      pending.delete(key);
      entry.send(msg);
      return;
    }
  }
});
upSocket.on('error', (e) => log(`[DNS] 上游套接字错误: ${e.message}`));

/* ---------- 服务器 ---------- */
/* Windows 分发规则:目的地址精确匹配的具体绑定 优先于 0.0.0.0 通配绑定。
   ICS 的 DNS 代理会精确绑定热点网关(如 192.168.137.1:53),通配绑定的我们
   会被它截走热点客户端查询。对策:对每个本机 IPv4 都做精确绑定(同地址同端口
   比谁最后绑),外加通配兜底;看门狗定期按接口轮换探测,被抢即全部重绑。 */

let udpSocks = []; // 当前全部服务套接字(0.0.0.0 + 127.0.0.1 + 各接口IP)
let ifKey = '';    // 上次的本机网段指纹(网卡变化 → 主动重绑)
let lastRebindAt = 0;

function attachUdp(addr) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (!addrAllowed(rinfo.address)) return;
    handleDns(msg, rinfo, (buf) => udp.send(buf, rinfo.port, rinfo.address));
  });
  udp.on('error', (e) => log(`[DNS] UDP(${addr}) 错误: ${e.message}`));
  udp.bind(cfg.dnsPort, addr, () => {
    if (addr !== '0.0.0.0') log(`[DNS] UDP :${cfg.dnsPort} 精确绑定 ${addr}`);
  });
  return udp;
}

function bindAllUdp(why) {
  const now = Date.now();
  if (why && now - lastRebindAt < 30000) return;
  lastRebindAt = now;
  if (why) log(`[DNS] 重绑全部 53 套接字(${why})`);
  const old = udpSocks;
  const addrs = new Set(['0.0.0.0', '127.0.0.1', ...ifList.map((f) => f.ip)]);
  udpSocks = [...addrs].map((a) => attachUdp(a)); // 先绑新再关旧,服务不断流
  setTimeout(() => { for (const s of old) { try { s.close(); } catch {} } }, 2000).unref();
  log(`[DNS] UDP :${cfg.dnsPort} 已监听 ${addrs.size} 个地址 (拦截 ${cfg.sinkholeDomain}${cfg.blockSubdomains ? '/*.子域' : ''} -> 按来源网段自动应答)`);
}

/* ---------- 53 端口归属看门狗 ---------- */
/* 场景:SharedAccess/Hyper-V 重启后会重新绑定 UDP 53,"最后绑定者收包"规则下
   本服务被挤掉 → 客户端查询被 ICS 代理放行到真 DNS,拦截失效。
   对策:每 20 秒从 127.0.0.1:PROBE_PORT 向 53 发一条对拦截域名的 A 查询,
   应答若是本机应有的 sinkhole IP(与 pickAnswerIP 计算比对)则归属正常,
   否则(真公网 IP / 不应答)即被抢 → 自动重绑夺回。 */
const PROBE_PORT = 15353; // 避开 Windows 排除端口区间(会 EACCES)
const PROBE_ID = 0xda7e;
let probeSock = null;
let probeOk = true;
let probeIdx = 0;
let probeFails = 0; // 连续失败计数:慢机器上偶发一次超时不算被抢

function buildProbeQuery() {
  const name = (cfg.sinkholeDomain || 'localhost').split('.');
  const qname = Buffer.concat([
    ...name.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')])),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(PROBE_ID, 0);
  head.writeUInt16BE(0x0100, 2); // RD
  head.writeUInt16BE(1, 4);
  return Buffer.concat([head, qname, Buffer.from([0, 1, 0, 1])]); // QTYPE=A QCLASS=IN
}

function firstAnswerIP(msg) {
  try {
    if (msg.readUInt16BE(6) === 0) return null; // ANCOUNT=0
    let i = 12; // 跳过问题段
    while (i < msg.length) { const l = msg[i]; if (l === 0) { i++; break; } if ((l & 0xc0) === 0xc0) { i += 2; break; } i += 1 + l; }
    i += 4; // QTYPE+QCLASS
    const type = msg.readUInt16BE(i + 2);
    const rdlen = msg.readUInt16BE(i + 10);
    if (type === TYPE_A && rdlen === 4) return `${msg[i + 12]}.${msg[i + 13]}.${msg[i + 14]}.${msg[i + 15]}`;
    return null;
  } catch { return null; }
}

function runProbe() {
  if (!probeSock) return;
  // 轮换探测目标:回环 + 真实接口 IP(热点网关/内网口全覆盖,虚拟交换机口不测)
  const targets = ['127.0.0.1', ...realIfs().map((f) => f.ip)];
  const dest = targets[probeIdx % targets.length];
  probeIdx++;
  const expected = pickAnswerIP(dest); // 本机发往自身接口 IP 时,源地址即该接口
  if (!expected) return;
  let done = false;
  const timer = setTimeout(() => {
    if (done) return; done = true;
    if (probeOk) probeFails++;
    probeOk = false;
    if (probeFails >= 2) { log(`[DNS] 探测 ${dest}:53 连续无应答 → 重绑夺回`); probeFails = 0; bindAllUdp(`看门狗:${dest} 无应答`); }
  }, 8000);
  const onData = (msg) => {
    if (done) return; done = true; clearTimeout(timer);
    probeSock.removeListener('message', onData);
    const got = firstAnswerIP(msg);
    const ok = got && got === expected;
    if (ok) {
      if (!probeOk) log(`[DNS] 探测恢复:53 归属正常(${dest} → ${got})`);
      probeOk = true;
      probeFails = 0;
    } else {
      probeFails++;
      if (probeFails >= 2) {
        log(`[DNS] 探测 ${dest}:53 连续应答异常(得 ${got || '空'},期望 ${expected})→ 被抢占,重绑`);
        probeOk = false; probeFails = 0;
        bindAllUdp(`看门狗:${dest} 应答异常`);
      }
    }
  };
  probeSock.on('message', onData);
  probeSock.send(buildProbeQuery(), cfg.dnsPort, dest);
}

function start(config, logger) {
  cfg = config;
  log = logger || log;
  refreshIfaces();
  ifKey = realIfs().map((f) => f.name + f.ip).join('|');
  log(`[DNS] 本机网段: ${ifList.map((f) => `${f.name}=${f.ip}`).join(', ') || '(未识别到物理IPv4)'}`);

  bindAllUdp(null);

  // 53 归属看门狗:启动 3 秒后立即探测,此后每 15 秒轮换目标一次
  probeSock = dgram.createSocket('udp4');
  probeSock.on('error', (e) => log(`[DNS] 探测套接字错误: ${e.message}`));
  probeSock.bind(PROBE_PORT, '0.0.0.0', () => {
    setTimeout(runProbe, 3000).unref();
    setInterval(runProbe, 15000).unref();
  });
  // 网卡/网段变化(插拔网卡、开关热点)→ 主动重绑抢最后绑定者
  setInterval(refreshWatch, 15000).unref();

  const tcp = net.createServer((sock) => {
    sock.on('error', () => sock.destroy());
    if (!addrAllowed(sock.remoteAddress)) return sock.destroy();
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        handleDns(Buffer.from(msg), { address: sock.remoteAddress, port: sock.remotePort }, (resp) => {
          const out = Buffer.alloc(2 + resp.length);
          out.writeUInt16BE(resp.length, 0);
          resp.copy(out, 2);
          sock.write(out);
        });
      }
    });
  });
  tcp.listen(cfg.dnsPort, '0.0.0.0', () => log(`[DNS] TCP :${cfg.dnsPort} 已监听`));
  tcp.on('error', (e) => log(`[DNS] TCP 错误: ${e.message}`));
}

module.exports = { start };
