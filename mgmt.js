'use strict';
/* ============================================================================
 * 管理中心核心 mgmt.js（零依赖 Node 脚本，v10 便携版核心）
 * 由「管理中心.bat」调起；也可直接：node mgmt.js <命令>
 *
 * 命令：
 *   menu            交互菜单（默认，双击 bat 进入）
 *   check           环境自检（节点/权限/配置/端口/任务/热点/冲突 一键体检）
 *   status          状态摘要（机器可读，--json 出 JSON）
 *   start|stop|restart   服务进程管理（多副本感知）
 *   hotspot on|off|status  经典 SoftAP 热点（纯 netsh，Win7 可用）
 *   install         注册 3 个计划任务 + 4 条防火墙规则（全部指向本文件夹）
 *   conflicts [--fix]    冲突检测：发现所有“别的副本”的任务/进程；--fix 归位到本文件夹
 *   uninstall [--dry|--purge|--cert]  一键卸载（默认只删注册项，文件保留）
 *   serve [--open]  启动本地可视化管理台 http://127.0.0.1:28790（网页配置/状态/日志）
 *
 * 设计红线（Win7 自适应）：
 *   - 不依赖 PowerShell 高级 cmdlet（Get-CimInstance/Get-NetAdapter/Get-ScheduledTask
 *     在 Win7 的 PS2.0 上全都没有）；系统操作只用 netsh / schtasks / taskkill /
 *     certutil / ipconfig / wmic，PowerShell 仅“ICS 共享”一步尝试（PS2 兼容 COM 语法）
 *   - 一切路径相对本文件所在目录 → 整个文件夹拷到哪都能跑
 *   - 写配置一律：config.json.bak 预留 + 临时文件原子替换
 *   - 进程匹配标记 --svc-sinkhole（沙箱测试用 --sandbox-test，不与保活互扰）
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const net = require('net');
const readline = require('readline');

const ROOT = __dirname;
const NODE = process.execPath;
const SVC_FLAG_REAL = '--svc-sinkhole';
// 测试钩子：MGMT_SVC_FLAG=--sandbox-test 时 start/stop 只碰沙箱实例（验证全流程用，
// 绝不误伤真实服务）；install/conflicts/uninstall 永远使用真实标记。
const SVC_FLAG = process.env.MGMT_SVC_FLAG || SVC_FLAG_REAL;
const TASK = { svc: 'iflytek-sinkhole', hot: 'sinkhole-hotspot', keep: 'sinkhole-keepalive' };
const FW_RULES = [
  ['Sinkhole-DNS-UDP', 'UDP', '53'],
  ['Sinkhole-DNS-TCP', 'TCP', '53'],
  ['Sinkhole-Web-TCP', 'TCP', '80'],
  ['Sinkhole-Web-TLS', 'TCP', '443']
];
const MGMT_PORT_BASE = 28790;
const LEGACY_TASKS = ['iflytek-sinkhole', 'sinkhole-hotspot', 'sinkhole-keepalive']; // 同 TASK，防手误

/* ---------------------------------------------------------------- 工具 */
let gbkDec = null;
try { gbkDec = new TextDecoder('gbk'); } catch { gbkDec = null; } // small-icu node 会抛，忽略
function dec(buf) {
  if (!buf) return '';
  if (gbkDec) {
    try {
      const s = gbkDec.decode(buf);
      if (s.indexOf('\uFFFD') === -1) return s; // GBK 解出来没替换符才可信
    } catch { /* fallthrough */ }
  }
  return buf.toString('utf8');
}
function slp(ms) { return new Promise(r => setTimeout(r, ms)); }
function runSync(cmd, args, opt) {
  opt = opt || {};
  try {
    const r = cp.spawnSync(cmd, args, {
      windowsHide: true, encoding: 'buffer',
      timeout: opt.timeout || 60000, maxBuffer: 16 * 1024 * 1024
    });
    const out = dec(r.stdout), err = dec(r.stderr);
    return { code: r.status == null ? -1 : r.status, out, err, all: (out + '\n' + err).trim(), ok: r.status === 0, sysErr: r.error ? String(r.error.message) : '' };
  } catch (e) { return { code: -1, out: '', err: String(e.message), all: String(e.message), ok: false, sysErr: String(e.message) }; }
}
function run(cmd, args, opt) {
  opt = opt || {};
  return new Promise(res => {
    let done = false;
    const finish = (code, out, err, sysErr) => { if (!done) { done = true; res({ code, out, err, all: (out + '\n' + err).trim(), ok: code === 0, sysErr: sysErr || '' }); } };
    let p;
    try { p = cp.spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish(-1, '', '', String(e.message)); }
    let ob = Buffer.alloc(0), eb = Buffer.alloc(0);
    p.stdout.on('data', d => { ob = Buffer.concat([ob, d]); });
    p.stderr.on('data', d => { eb = Buffer.concat([eb, d]); });
    const to = setTimeout(() => { try { p.kill(); } catch {} finish(-1, dec(ob), dec(eb) + '\n[timeout]', ''); }, opt.timeout || 90000);
    p.on('error', e => { clearTimeout(to); finish(-1, '', '', String(e.message)); });
    p.on('close', c => { clearTimeout(to); finish(c == null ? -1 : c, dec(ob), dec(eb), ''); });
  });
}
function isAdmin() { return runSync('net', ['session']).ok; }
function cfgPath() { return path.join(ROOT, 'config.json'); }
function loadCfg() {
  try { return { cfg: JSON.parse(fs.readFileSync(cfgPath(), 'utf8')), src: 'config.json' }; } catch (e1) {
    try { return { cfg: JSON.parse(fs.readFileSync(cfgPath() + '.bak', 'utf8')), src: 'config.json.bak', fallback: true }; }
    catch (e2) { return { cfg: null, error: `${e1.message} / bak: ${e2.message}` }; }
  }
}
function saveCfg(cfg) {
  const p = cfgPath();
  try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); } catch {}
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p); // Windows 上 rename 直接替换目标
  return true;
}
function logFile(name, msg) {
  try {
    const d = path.join(ROOT, 'logs');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, name), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
function tail(file, n) {
  try {
    const t = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    return t.slice(Math.max(0, t.length - (n || 200))).join('\n');
  } catch (e) { return `(无法读取 ${file}: ${e.message})`; }
}

/* ------------------------------------------------------- 进程（多副本感知） */
function svcProcs(flag) {
  const FL = flag || SVC_FLAG;
  // 严格双条件：命令行必须 同时含启动标记 + index.js —— 只含标记字符串的
  // 进程（如调试脚本文本自匹配）一律不算，防 stop 误杀无关进程
  const isSvc = c => c.indexOf(FL) !== -1 && /index\.js/i.test(c);
  // 链1: PowerShell Get-CimInstance(Win8+/PS3+)  链2: Get-WmiObject(Win7/PS2)  链3: wmic
  const ps = `$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*${FL}*' }); if(-not $p){ $p = @(Get-WmiObject Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*${FL}*' }) }; $p | ForEach-Object { "$($_.ProcessId)~|~$($_.CommandLine)" }`;
  let r = runSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000 });
  if (r.ok) {
    const out = [];
    for (const line of r.out.split(/\r?\n/)) {
      const m = line.match(/^(\d+)~\|~(.*)$/);
      if (m && isSvc(m[2])) out.push({ pid: +m[1], cmd: m[2].trim() });
    }
    return out; // 空也是可信结果（命令成功）
  }
  r = runSync('wmic', ['process', 'where', "Name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:list'], { timeout: 20000 });
  const out = []; let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    const m1 = line.match(/^CommandLine=(.*)$/); if (m1) { cur = m1[1].trim(); continue; }
    const m2 = line.match(/^ProcessId=(\d+)$/); if (m2 && cur) {
      if (isSvc(cur)) out.push({ pid: +m2[1], cmd: cur });
      cur = null;
    }
  }
  return out;
}
function srcDirOf(cmd) {
  // 从命令行提取“属于哪个副本目录”（index.js / mgmt.js / keepalive.js / *.ps1 任一路径）
  const m = cmd.match(/"([^"]+\\(?:index|mgmt|keepalive|hotspot|keep-alive)[^"]*\.(?:js|ps1))"/i)
    || cmd.match(/(?:^|\s)([^"\s]+\\(?:index|mgmt|keepalive|hotspot|keep-alive)[^"]*\.(?:js|ps1))/i);
  if (m) { try { return path.dirname(m[1]); } catch {} }
  return '';
}
async function stopSvc(flag) {
  const ps = svcProcs(flag || SVC_FLAG);
  const killed = [], failed = [];
  for (const p of ps) {
    const r = runSync('taskkill', ['/PID', String(p.pid), '/F'], { timeout: 15000 });
    (r.ok ? killed : failed).push(p.pid);
  }
  await slp(600);
  return { found: ps.length, killed, failed, remain: svcProcs(flag || SVC_FLAG).length };
}
async function startSvc(opts) {
  opts = opts || {};
  const exist = svcProcs();
  if (exist.length) return { ok: true, already: true, pids: exist.map(p => p.pid), msg: `服务已在运行（PID ${exist.map(p => p.pid).join(', ')}）` };
  const { cfg } = loadCfg();
  if (!cfg) return { ok: false, msg: 'config.json 不可用，先修复配置（check 有详情）' };
  if (!cfg.relay || !cfg.relay.enabled) return { ok: false, msg: 'relay.enabled=false，无法以本模式启动' };
  const idx = path.join(ROOT, 'index.js');
  if (!fs.existsSync(idx)) return { ok: false, msg: 'index.js 不存在：' + idx };
  try {
    const c = cp.spawn(NODE, [idx, SVC_FLAG], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
  } catch (e) { return { ok: false, msg: '启动失败: ' + e.message }; }
  // 探活：relay TCP → /api/info HTTP；最多 15s
  const port = +((cfg.relay && cfg.relay.port) || 28791);
  let httpOk = false;
  for (let i = 0; i < 30; i++) {
    await slp(500);
    const ps = svcProcs();
    if (!ps.length) {
      return { ok: false, msg: '进程立即退出了', log: tail('logs/sinkhole.log', 15) };
    }
    httpOk = await httpProbe(port, '/api/info', 1500);
    if (httpOk) break;
  }
  const pids = svcProcs().map(p => p.pid);
  if (httpOk) return { ok: true, pids, msg: `服务已启动并应答（PID ${pids.join(', ')}，http://127.0.0.1:${port}）` };
  return { ok: pids.length > 0, pids, msg: pids.length ? `进程存活但 /api/info 15s 内未应答（PID ${pids.join(', ')}）` : '启动失败', log: tail('logs/sinkhole.log', 15) };
}
function httpProbe(port, p, ms) {
  return new Promise(res => {
    let done = false;
    const ok = v => { if (!done) { done = true; res(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: p || '/api/info', timeout: ms || 2000 }, r => { r.resume(); ok(true); });
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.on('error', () => ok(false));
  });
}
function dnsProbe(port, ms) {
  return new Promise(res => {
    let done = false;
    const ok = v => { if (!done) { done = true; res(v); } };
    const s = dgram.createSocket('udp4');
    // A 查询 iflytek.com, ID=0x7a11, RD=1
    const q = Buffer.from([0x7a, 0x11, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      7, 105, 102, 108, 121, 116, 101, 107, 3, 99, 111, 109, 0, 0, 1, 0, 1]);
    try {
      s.send(q, port || 53, '127.0.0.1');
      const t = setTimeout(() => { try { s.close(); } catch {} ok(false); }, ms || 2000);
      s.on('message', () => { clearTimeout(t); try { s.close(); } catch {} ok(true); });
      s.on('error', () => { clearTimeout(t); ok(false); });
    } catch { ok(false); }
  });
}
function tcpProbe(port, ms) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = v => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(ms || 1500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/* --------------------------------------------------------------- 计划任务 */
function taskExists(name) { return runSync('schtasks', ['/query', '/tn', name], { timeout: 15000 }).ok; }
function taskInfo(name) {
  const r = runSync('schtasks', ['/query', '/tn', name, '/fo', 'LIST', '/v'], { timeout: 20000 });
  if (!r.ok) return { exists: false };
  const runM = r.all.match(/(?:Task To Run|要运行的任务)\s*[:：]\s*(.+)/);
  // 状态字段本地化极坑：英文=Status，中文 /v 实测标签是「模式」（值: 正在运行/就绪），
  // 而「计划任务状态」是另一个字段（已启用/已禁用）——必须行首锚定标签，别匹配到它
  const stM = r.all.match(/^\s*(?:Status|模式|状态)\s*[:：]\s*(\S[^\r\n]*)$/m);
  const runLine = runM ? runM[1].trim() : '';
  let src = '';
  const pm = runLine.match(/"([^"]+\\[^"]+\.(?:js|ps1))"/i);
  if (pm) { try { src = path.dirname(pm[1]); } catch {} }
  if (!src && runLine) {
    const pm2 = runLine.match(/([^"\s]+\\[^"\s]+\.(?:js|ps1))/i);
    if (pm2) { try { src = path.dirname(pm2[1]); } catch {} }
  }
  const st = stM ? stM[1].trim() : '';
  const running = /running|正在运行|运行中/i.test(st);
  return { exists: true, runLine, src, state: st, running };
}
function taskCreate(name, tr, extra) {
  const args = ['/create', '/tn', name, '/tr', tr, '/f'];
  (extra || []).forEach(a => args.push(a));
  return runSync('schtasks', args, { timeout: 25000 });
}
function taskDelete(name) { return runSync('schtasks', ['/delete', '/tn', name, '/f'], { timeout: 15000 }); }

/* ----------------------------------------------------------------- 防火墙 */
function firewallEnsure() {
  const res = [];
  for (const [name, proto, port] of FW_RULES) {
    let r = runSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', `protocol=${proto}`, `localport=${port}`, 'profile=any']);
    if (!r.ok) r = runSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', `protocol=${proto}`, `localport=${port}`, 'profile=domain,private,public']);
    runSync('netsh', ['advfirewall', 'firewall', 'set', 'rule', `name=${name}`, 'new', 'remoteip=LocalSubnet']);
    res.push({ name, ok: r.ok, note: r.ok ? '已添加' : (r.all || r.sysErr) });
  }
  return res;
}
function firewallHas(name) { return runSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], { timeout: 15000 }).ok; }

/* ----------------------------------------------------------- 热点（netsh） */
function wlan(args, timeout) { return runSync('netsh', ['wlan'].concat(args), { timeout: timeout || 30000 }); }
function hotspotStatus() {
  const r = wlan(['show', 'hostednetwork']);
  const all = r.all;
  const started = /(?:Status|状态)\s*[:：]\s*(Started|已启动|已开启)/i.test(all);
  const allowed = /(?:Mode|模式)\s*[:：]\s*(Allowed|已启用|允许)/i.test(all);
  const ssidM = all.match(/SSID\s*(?:name|名称)\s*[:：]\s*[“"]?([^”"\r\n]+?)\s*[”"]?(?:\r|$)/i);
  // zh 实测两字段:设置区「最多客户端数:100」(上限) vs 状态区「客户端数:0」(当前) —— 双字 lookbehind 排除前者
  const clientsM = all.match(/(?:Number of clients|当前客户端数|(?<!最多)客户端数)\s*[:：]\s*(\d+)/i);
  return { started, allowed, ssid: ssidM ? (ssidM[1] || '').trim() : '', clients: clientsM ? +clientsM[1] : 0, raw: all };
}
function wlanIfaces() {
  // netsh wlan show interfaces → [{name, ssid, state, signal}]（中英字段名都吃）
  const r = wlan(['show', 'interfaces']);
  const out = [];
  for (const blk of r.all.split(/(?=^\s*(?:Name|名称)\s*[:：])/m)) {
    const nm = blk.match(/^\s*(?:Name|名称)\s*[:：]\s*(.+)$/m);
    if (!nm) continue;
    const ssid = blk.match(/^\s*SSID\s*[:：]\s*(.+)$/m);
    const st = blk.match(/^\s*(?:State|状态)\s*[:：]\s*(.+)$/m);
    const sig = blk.match(/^\s*(?:Signal|信号)\s*[:：]\s*(\d+)/m);
    out.push({ name: nm[1].trim(), ssid: ssid ? ssid[1].trim() : '', state: st ? st[1].trim() : '', signal: sig ? +sig[1] : -1 });
  }
  return out;
}
function wlanDrivers() {
  // 每块网卡一节：Interface name / Hosted network supported
  // 中文 netsh 的字段名实测两种：「支持的承载网络」(Win10 zh) 与「承载网络支持」(部分版本)；英文 "Hosted network supported"
  const r = wlan(['show', 'drivers']);
  const out = [];
  for (const blk of r.all.split(/(?=(?:Interface name|接口名称)\s*[:：])/m)) {
    const nm = blk.match(/(?:Interface name|接口名称)\s*[:：]\s*(.+)$/m);
    if (!nm) continue;
    const sup = blk.match(/(?:Hosted network supported|支持的承载网络|承载网络支持)\s*[:：]\s*(\S+)/i);
    out.push({ name: nm[1].trim(), supported: sup ? /^y|^是/i.test(sup[1].trim()) : null });
  }
  return out;
}
function pickNic(cfg) {
  const want = (cfg.relay && cfg.relay.hotspot && cfg.relay.hotspot.nic) || '';
  const drvs = wlanDrivers().filter(d => !/vEthernet|本地连接\*|Hosted Network|Wi-Fi Direct|Hyper-V|Virtual Switch|WAN Miniport/i.test(d.name));
  if (want) {
    const hit = drvs.filter(d => d.name === want);
    if (hit.length) return hit[0];
  }
  const sup = drvs.filter(d => d.supported !== false);
  return sup[0] || drvs[0] || null;
}
function apAdapterName() {
  // 虚拟 AP 适配器名（给 AP 口配静态 IP 用）：PS(8+) → wmic → 空
  let r = runSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-NetAdapter -IncludeHidden -EA SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Hosted Network*' } | Select-Object -First 1 -ExpandProperty Name"], { timeout: 15000 });
  const n1 = r.out.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  if (r.ok && n1) return n1;
  r = runSync('wmic', ['nic', 'where', "Name like '%Hosted Network%'", 'get', 'NetConnectionID', '/format:list'], { timeout: 15000 });
  const m = r.out.match(/NetConnectionID=(.+)/);
  return m ? m[1].trim() : '';
}
async function hotspotStart(opts) {
  opts = opts || {};
  const L = [];
  const say = m => { L.push(m); logFile('hotspot.log', m); };
  const { cfg } = loadCfg();
  const hs = (cfg && cfg.relay && cfg.relay.hotspot) || {};
  const ssid = opts.ssid || hs.ssid || 'China_Unicom';
  const key = opts.key || hs.key || 'unicom2026';
  const st = hotspotStatus();
  if (st.started) return { ok: true, already: true, ssid: st.ssid, log: L.concat(['热点已在运行: ' + st.ssid]) };

  const nic = pickNic(cfg || {});
  if (!nic) return { ok: false, log: L.concat(['未找到无线网卡（USB 网卡插好了吗？驱动装了吗？）']) };
  say(`无线网卡: ${nic.name}`);
  if (nic.supported === false) return { ok: false, log: L.concat([`网卡「${nic.name}」驱动不支持承载网络，无法经典 SoftAP。可用系统“移动热点”，或换支持 AP 的网卡`]) };

  // STA 先连上联网（信道跟随，2.4G 老设备才搜得到）——失败只警告不阻断
  const staSsid = opts.staSsid || hs.staSsid || '';
  const staKey = opts.staKey || hs.staKey || '';
  const staRes = await staConnect(staSsid, nic.name, staKey, say);
  say(staRes.msg);
  let staDisconnected = false;

  // 启动三步曲 + 失败重试（STA/AP 并发状态机易毛）
  wlan(['set', 'hostednetwork', 'mode=allow', `ssid=${ssid}`, `key=${key}`, 'keyUsage=persistent']);
  for (let attempt = 1; attempt <= 2; attempt++) {
    wlan(['stop', 'hostednetwork']);
    await slp(800);
    wlan(['start', 'hostednetwork']);
    await slp(4000);
    if (hotspotStatus().started) break;
    say(`第 ${attempt} 次启动未成功，断开 STA 清残留重试…`);
    wlan(['disconnect']);
    staDisconnected = true;
    await slp(3000);
  }
  const after = hotspotStatus();
  if (!after.started) return { ok: false, log: L.concat(['热点启动失败：重跑一次；仍失败则拔插 USB 网卡后重试']) };
  say(`热点已广播: ${ssid} / ${key}（WPA2-Personal）`);
  // 重试路径断过 STA —— 必须接回：①信道跟随(老设备 2.4G 才搜得到) ②下次开热点自动沿用
  if (staDisconnected && staRes.target) {
    wlan(['connect', `name=${staRes.target}`, `interface=${nic.name}`]);
    let back = false;
    for (let i = 0; i < 4; i++) {
      await slp(4000);
      const now = wlanIfaces().find(i2 => i2.name === nic.name) || wlanIfaces()[0];
      if (now && /^(connected|已连接)\s*$/i.test(String(now.state || '').trim())) { back = true; break; }
    }
    say(back ? `STA 已重连 ${staRes.target}（信道跟随恢复）` : `STA 未能重连 ${staRes.target}（热点不受影响；老设备搜不到时手动连回上联网再开热点）`);
  }

  // ICS 共享（Win7 可用的 PS2 兼容 COM 脚本）→ 失败退化为 AP 口静态 192.168.137.1
  const gw = defaultGwAlias();
  const ap = apAdapterName();
  let icsOk = false;
  if (gw && ap) {
    const ps = `$ns=New-Object -ComObject HNetCfg.HNetShare;$pub=$null;$prv=$null;foreach($c in $ns.EnumEveryConnection){$n=$ns.NetConnectionProps($c).Name;if($n -eq '${gw.replace(/'/g, "''")}'){$pub=$c};if($n -eq '${ap.replace(/'/g, "''")}'){$prv=$c}};if($pub -and $prv){$a=$ns.INetSharingConfigurationForINetConnection($pub);if(-not $a.SharingEnabled){$a.EnableSharing(0)};$b=$ns.INetSharingConfigurationForINetConnection($prv);if($b.SharingEnabled){$b.DisableSharing()};if(-not $b.SharingEnabled){$b.EnableSharing(1)};Write-Output 'ICS-OK'}else{Write-Output 'ICS-NOCONN'}`;
    const r = await run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 30000 });
    icsOk = /ICS-OK/.test(r.out);
    say(icsOk ? `ICS 共享: ${gw} → ${ap}` : `ICS 共享未挂上（${(r.out || r.err || '').trim().slice(0, 120) || '连接未找到'}），走静态 IP 兜底`);
  } else say(`出口网卡(${gw || '?'})或 AP 口(${ap || '?'})没识别到，跳过 ICS`);
  if (!icsOk && ap) {
    // 内置 DHCP 发 192.168.137.x，AP 口必须有 .1 才能让设备把 137.1 当网关
    const r = runSync('netsh', ['interface', 'ipv4', 'set', 'address', `name=${ap}`, 'static', '192.168.137.1', '255.255.255.0', 'none'], { timeout: 20000 });
    if (r.ok) say(`AP 口 ${ap} 已配静态 192.168.137.1/24（DHCP 网关就位；如需共享上网请手动开 ICS）`);
    else say(`AP 口静态 IP 设置失败：${(r.all || r.sysErr).slice(0, 160)}`);
  }
  // 关 ICS DNS 代理（否则截走热点客户端发往 137.1:53 的查询）
  const rDns = await run('powershell.exe', ['-NoProfile', '-Command',
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters';if((Get-ItemProperty $k -EA SilentlyContinue).DnsProxyEnabled -ne 0){Set-ItemProperty $k DnsProxyEnabled 0 -Type DWord -Force;Restart-Service SharedAccess -Force -EA SilentlyContinue;Write-Output 'DNSPROXY-OFF'}"], { timeout: 30000 }).catch(() => ({ out: '' }));
  if (/DNSPROXY-OFF/.test(rDns.out || '')) say('ICS DNS 代理已关闭（sinkhole 直接应答客户端）');
  say(`完成。设备连接 ${ssid} 后浏览器打开 http://iflytek.com`);
  return { ok: true, ssid, log: L };
}
async function staConnect(explicitSsid, nicName, key, say) {
  const isConn = v => /^(connected|已连接)\s*$/i.test(String(v || '').trim()); // EN "disconnected" 含 connected 子串，必须整值锚定
  const R = (msg, target, connected) => ({ msg, target: target || '', connected: !!connected });
  try {
    let target = explicitSsid;
    const ifaces = wlanIfaces();
    const cur = ifaces.find(i => isConn(i.state) && i.ssid);
    if (!target) {
      // 自动挑：已保存 profile 且在范围内，信号最强（出门换网零配置）
      const seen = wlan(['show', 'networks', 'mode=bssid']).all;
      const profR = runSync('netsh', ['wlan', 'show', 'profiles']);
      const profs = [];
      for (const m of profR.all.matchAll(/(?:All User Profile|所有用户配置文件|用户配置文件)\s*[:：]\s*(.+)$/gm)) profs.push(m[1].trim());
      let best = null;
      for (const blk of seen.split(/(?=SSID\s+\d+\s*[:：])/)) {
        const s = blk.match(/SSID\s+\d+\s*[:：]\s*(.+)/); if (!s) continue;
        const name = s[1].trim();
        if (!name || profs.indexOf(name) === -1) continue;
        if (cur && cur.ssid === name) return R(`上联网已连接 ${name}（无需切换）`, name, true);
        const sg = blk.match(/(?:Signal|信号)\s*[:：]\s*(\d+)%/);
        const sig = sg ? +sg[1] : 0;
        if (!best || sig > best.sig) best = { name, sig };
      }
      target = best ? best.name : '';
      if (target) say(`上联网自动选择: ${target}（已保存且信号最强，出门换网免改配置）`);
    }
    if (!target) target = 'CU_2kyA'; // 老默认
    if (cur && cur.ssid === target) return R(`上联网已连接 ${target}（热点将跟随其信道）`, target, true);
    if (key) runSync('netsh', ['wlan', 'add', 'profile', `name=${target}`, `key=${key}`, 'user=all']); // 新网先存密码
    const c = wlan(['connect', `name=${target}`, `interface=${nicName}`]);
    if (!/successfully|成功/i.test(c.all)) return R(`连 ${target} 被拒，热点照常开（上联网只为跟随 2.4G 信道）`, target, false);
    for (let i = 0; i < 12; i++) { // 最多 60s
      await slp(5000);
      const now = wlanIfaces().find(i2 => i2.name === nicName) || wlanIfaces()[0];
      if (now && isConn(now.state) && now.ssid === target) return R(`上联网已连 ${target}，热点将跟随其 2.4G 信道`, target, true);
    }
    return R(`上联网 ${target} 60s 内未连上——热点照常开（今晚在家大概率仍在 2.4G）`, target, false);
  } catch (e) { return R('上联网探测异常（不影响热点）: ' + e.message, '', false); }
}
async function hotspotStop() {
  const st = hotspotStatus();
  if (!st.started) return { ok: true, msg: '热点本来就是关闭的' };
  wlan(['stop', 'hostednetwork']);
  await slp(1200);
  const after = hotspotStatus();
  logFile('hotspot.log', '热点已停止');
  return { ok: !after.started, msg: after.started ? '停止命令已发但状态仍 Started' : '热点已停止' };
}
function defaultGwAlias() {
  const r = runSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias"], { timeout: 15000 });
  const v = r.out.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  if (r.ok && v && v !== '') return v;
  // Win7 回退：route print 解析
  const r2 = runSync('route', ['print', '0.0.0.0']);
  const m = r2.out.match(/\d+\.\d+\.\d+\.\d+\s+\d+\.\d+\.\d+\.\d+\s+(\S+)\s+/);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------- 安装/卸载 */
function installAll() {
  const res = { tasks: [], firewall: [], warn: [] };
  const nodeQ = `"${NODE}"`;
  const defs = [
    [TASK.svc, `${nodeQ} "${path.join(ROOT, 'index.js')}" ${SVC_FLAG}`, ['/sc', 'onstart', '/delay', '0000:30', '/ru', 'SYSTEM', '/rl', 'HIGHEST']],
    [TASK.hot, `${nodeQ} "${path.join(ROOT, 'mgmt.js')}" hotspot --auto --retry`, ['/sc', 'onstart', '/delay', '0001:00', '/ru', 'SYSTEM', '/rl', 'HIGHEST']],
    [TASK.keep, `${nodeQ} "${path.join(ROOT, 'keepalive.js')}"`, ['/sc', 'minute', '/mo', '5', '/ru', 'SYSTEM', '/rl', 'HIGHEST']]
  ];
  for (const [name, tr, extra] of defs) {
    const before = taskInfo(name);
    const r = taskCreate(name, tr, extra);
    const after = taskInfo(name);
    res.tasks.push({
      name, ok: r.ok && after.exists, repointed: before.exists && before.src && before.src !== ROOT,
      before: before.src || (before.exists ? '(无法解析)' : '不存在'), after: after.src || ROOT,
      note: r.ok ? 'OK' : (r.all || r.sysErr).slice(0, 160)
    });
  }
  res.firewall = firewallEnsure();
  if (!fs.existsSync(path.join(ROOT, 'certs', 'iflytek.pfx'))) res.warn.push('certs\\iflytek.pfx 缺失：HTTPS/443 起不来。整个文件夹拷贝时带上 certs 目录');
  const c = loadCfg();
  if (!c.cfg) res.warn.push('config.json 损坏或缺失: ' + (c.error || ''));
  if (!isAdmin()) res.warn.push('当前非管理员：任务/防火墙注册可能失败（用 管理中心.bat 右键以管理员运行，或同意 UAC）');
  return res;
}
async function uninstall(o) {
  o = o || {};
  const steps = [];
  const dry = !!o.dry;
  const push = (name, detail) => steps.push({ name, detail });

  const procs = svcProcs();
  const tasks = [TASK.svc, TASK.hot, TASK.keep].map(n => ({ n, info: taskInfo(n) }));
  const hs = hotspotStatus();
  const fws = FW_RULES.map(([n]) => ({ n, has: firewallHas(n) }));
  const would = {
    procs: procs.map(p => ({ pid: p.pid, dir: srcDirOf(p.cmd) || '?' })),
    tasks: tasks.filter(t => t.info.exists).map(t => ({ name: t.n, src: t.info.src })),
    hotspot: hs.started, firewall: fws.filter(f => f.has).map(f => f.n),
    purge: !!o.purge, cert: !!o.cert, dir: ROOT
  };
  if (dry) {
    push('【演练】以上为将被移除的清单（不执行）', JSON.stringify(would, null, 2));
    return { ok: true, dry: true, would, steps };
  }
  if (!isAdmin()) return { ok: false, needAdmin: true, would, steps, msg: '卸载需要管理员权限（先用 管理中心.bat 提权重跑）' };

  // ① 先杀保活源头之前：先停服务（防止杀完被 keepalive 拉回）——卸载永远针对真实标记
  const stop = await stopSvc(SVC_FLAG_REAL);
  push('停止服务进程', `发现 ${stop.found} 个，已停 ${stop.killed.length}${stop.remain ? `，残留 ${stop.remain}` : ''}`);
  // ② 删 3 个任务（keepalive 必须删，否则 5 分钟复活）
  for (const t of tasks) {
    if (!t.info.exists) { push(`任务 ${t.n}`, '不存在(跳过)'); continue; }
    const r = taskDelete(t.n);
    push(`删除任务 ${t.n}`, r.ok ? `OK（原指向 ${t.info.src || '?'}）` : (r.all || r.sysErr).slice(0, 120));
  }
  // ③ 防火墙规则
  for (const f of fws) {
    if (!f.has) { push(`防火墙 ${f.n}`, '无'); continue; }
    const r = runSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${f.n}`]);
    push(`删除防火墙 ${f.n}`, r.ok ? 'OK' : (r.all || '').slice(0, 80));
  }
  // ④ 热点
  if (hs.started) { const r = await hotspotStop(); push('热点', r.msg); } else push('热点', '本来就关着');
  // ⑤ 证书存储（可选）
  if (o.cert) {
    const r = certStoreClean();
    push('证书存储', r.msg);
  } else push('证书存储', '保留（要清加 --cert）');
  // ⑥ 文件夹（可选自删）
  if (o.purge) {
    const okPurge = schedulePurge();
    push('删除本文件夹', okPurge ? '已安排：脚本退出后自动删除（有占用会留 _残留.txt）' : '安排失败，手动删除');
  } else push('文件/数据', `保留（要连文件夹一起删：管理中心.bat → 卸载 → 选“删除本文件夹”）`);
  const remain = svcProcs().length;
  return { ok: remain === 0, would, steps, remain, msg: remain ? `仍有 ${remain} 个服务进程未停` : '卸载完成' };
}
function certStoreClean() {
  const r = runSync('certutil', ['-store', '-user', 'My'], { timeout: 20000 });
  if (!r.ok) return { msg: 'certutil 查询失败: ' + (r.all || r.sysErr).slice(0, 100) };
  let n = 0; const blocks = r.out.split(/={10,}\s*Certificate/);
  for (const b of blocks) {
    if (!/sinkhole-/i.test(b)) continue;
    const h = b.match(/(?:Certificate Hash\(sha1\)|Hash\(sha1\)|SHA1哈希)\s*:\s*([0-9a-f]+)/i);
    if (h) { const d = runSync('certutil', ['-delstore', '-user', 'My', h[1]]); if (d.ok) n++; }
  }
  return { msg: `已清理 sinkhole-* 证书 ${n} 条` };
}
function schedulePurge() {
  try {
    const tmp = os.tmpdir() || 'C:\\Windows\\Temp';
    const bat = path.join(tmp, `sinkhole-purge-${Math.floor(Math.random() * 1e6)}.bat`);
    const lines = [
      '@echo off',
      'ping -n 6 127.0.0.1 >nul',
      `rd /s /q "${ROOT}"`,
      `ping -n 3 127.0.0.1 >nul`,
      `if exist "${ROOT}" rd /s /q "${ROOT}"`,
      `if exist "${ROOT}" echo leftover> "${ROOT}\\_残留_重启后再删.txt"`,
      `del "%~f0"`
    ];
    fs.writeFileSync(bat, lines.join('\r\n'), 'ascii');
    const c = cp.spawn('cmd', ['/c', 'start', '', '/min', 'cmd', '/c', bat], { windowsHide: false, detached: true, stdio: 'ignore' });
    c.unref();
    return true;
  } catch { return false; }
}

/* ----------------------------------------------------------- 冲突检测/归位 */
function conflicts() {
  const rootNorm = p => { try { return path.resolve(p).toLowerCase().replace(/[\\/]+$/, ''); } catch { return String(p || '').toLowerCase(); } };
  const ROOTn = rootNorm(ROOT);
  const items = [];
  const copies = {};
  const addCopy = (src, via) => {
    const k = rootNorm(src);
    if (!copies[k]) copies[k] = { dir: src, via: [] };
    copies[k].via.push(via);
  };
  for (const name of [TASK.svc, TASK.hot, TASK.keep]) {
    const i = taskInfo(name);
    if (!i.exists) { items.push({ kind: 'task', name, status: 'missing', detail: '未注册（用 install 装上）' }); continue; }
    const same = i.src ? rootNorm(i.src) === ROOTn : null;
    items.push({
      kind: 'task', name,
      status: same === true ? 'ok' : (same === false ? 'foreign' : 'unknown'),
      detail: `${i.runLine}${i.src ? '  → 目录: ' + i.src : ''}`
    });
    if (i.src && same === false) addCopy(i.src, '任务 ' + name);
    if (i.src && same === true && name === TASK.svc && !i.running) { /* live task ok but idle */ }
  }
  const ps = svcProcs(SVC_FLAG_REAL); // 冲突检测永远针对真实服务标记
  for (const p of ps) {
    const dir = srcDirOf(p.cmd);
    const same = dir ? rootNorm(dir) === ROOTn : null;
    items.push({ kind: 'proc', name: 'PID ' + p.pid, status: same === true ? 'ok' : (same === false ? 'foreign' : 'unknown'), detail: p.cmd });
    if (dir && same === false) addCopy(dir, '进程 PID ' + p.pid);
  }
  const foreign = Object.keys(copies).filter(k => k !== ROOTn).map(k => copies[k]);
  return { root: ROOT, items, copies: Object.values(copies), foreign, clean: foreign.length === 0 };
}
async function conflictsFix() {
  const rep = conflicts();
  const steps = [];
  if (rep.foreign.length) {
    const st = await stopSvc(); // 杀掉所有副本的服务进程（标记匹配，不分目录）
    steps.push(`停止全部服务进程: 发现 ${st.found}，已停 ${st.killed.length}`);
  }
  const ins = installAll(); // 3 任务重指向本文件夹
  steps.push(...ins.tasks.map(t => `任务 ${t.name}: ${t.ok ? 'OK' : '失败 ' + t.note}`));
  steps.push(...ins.firewall.map(f => `防火墙 ${f.name}: ${f.ok ? 'OK' : '失败'}`));
  return { rep, steps, ins };
}

/* ------------------------------------------------------------------ 自检 */
async function check(o) {
  o = o || {};
  const lines = []; const j = {};
  const P = (level, text) => { lines.push(`[${level}] ${text}`); };
  // 系统/节点
  const rel = os.release(); const ver = process.versions.node;
  const major = +ver.split('.')[0];
  j.os = rel; j.node = ver; j.nodePath = NODE;
  const isWin7 = /^6\.1/.test(rel);
  if (major >= 14) P('OK', `Node ${ver}（兼容 Win7 起步线 ≥14）路径: ${NODE}`);
  else P('!!', `Node ${ver} 过旧（建议 ≥14；低于 12 缺 optional chaining 会崩本项目 JS）`);
  if (isWin7 && major >= 20) P('!!', `检测到 Win7 (6.1)，Node ${ver} 不支持 Win7 —— 请把 Node14 便携版 node.exe 放入 runtime-win7\\ 重跑本 bat`);
  else if (isWin7) P('OK', 'Win7 检测到，当前 Node 兼容');
  if (major >= 20 && isWin7 === false) P('--', `Node ${ver} 需要 Win10+；若本机是 Win7 会启动失败（用 runtime-win7\\node.exe）`);
  // 权限
  const admin = isAdmin(); j.admin = admin;
  P(admin ? 'OK' : '!!', admin ? '管理员权限：安装/卸载/热点/53端口可用' : '非管理员：仅能看状态/改配置；安装·卸载·热点需管理员（bat 同意 UAC 重开即可）');
  // 配置
  const c = loadCfg(); j.config = c.cfg ? 'ok' : 'bad';
  if (!c.cfg) P('!!', 'config.json 与 .bak 都不可用: ' + (c.error || ''));
  else {
    P(c.fallback ? '!!' : 'OK', c.fallback ? 'config.json 损坏，已回退 .bak —— 立即在管理台重新保存一次以修复' : `config.json 正常（relay :${(c.cfg.relay && c.cfg.relay.port) || 28791}，DNS :${c.cfg.dnsPort || 53}）`);
    const ac = c.cfg.relay && c.cfg.relay.auth;
    if (ac && ac.enabled && ac.accounts) P('--', `登录账号 ${Object.keys(ac.accounts).length} 个（明文存本地，注意仓库公开勿提交隐私）`);
  }
  // 证书/存储
  const hasPfx = fs.existsSync(path.join(ROOT, 'certs', 'iflytek.pfx'));
  j.cert = hasPfx; P(hasPfx ? 'OK' : '!!', hasPfx ? 'certs\\iflytek.pfx 存在（443 HTTPS 可用）' : 'certs\\iflytek.pfx 缺失：443 起不来，拷贝整个文件夹时带上 certs');
  const hasStorage = fs.existsSync(path.join(ROOT, 'storage'));
  j.storage = hasStorage;
  // 端口（带 1 次重试：首跑冷启动/EDR 扫描偶发超时会误报，or 掉两轮取真）
  const relayPort = (c.cfg && c.cfg.relay && +c.cfg.relay.port) || 28791;
  const dnsPort = (c.cfg && +c.cfg.dnsPort) || 53;
  let dnsOK = await dnsProbe(dnsPort, 1500);
  if (!dnsOK) { await slp(400); dnsOK = await dnsProbe(dnsPort, 1500); }
  let relayOK = await tcpProbe(relayPort, 1200);
  if (!relayOK) { await slp(300); relayOK = await tcpProbe(relayPort, 1200); }
  let httpOK = relayOK ? await httpProbe(relayPort, '/api/info', 2000) : false;
  if (relayOK && !httpOK) { await slp(400); httpOK = await httpProbe(relayPort, '/api/info', 2500); }
  j.ports = { dns: dnsOK, relayTcp: relayOK, relayHttp: httpOK };
  P(dnsOK ? 'OK' : '--', dnsOK ? `DNS :${dnsPort} 应答正常（服务活着）` : `DNS :${dnsPort} 无应答（服务未跑或被占）`);
  P(httpOK ? 'OK' : (relayOK ? '!!' : '--'), httpOK ? `中继站 http://127.0.0.1:${relayPort} 应答正常` : (relayOK ? `端口 ${relayPort} 有监听但 /api/info 不应答（可能异常）` : `中继站 :${relayPort} 未监听`));
  // 进程
  const ps = svcProcs(); j.procs = ps.map(p => ({ pid: p.pid, dir: srcDirOf(p.cmd) }));
  P(ps.length === 1 ? 'OK' : (ps.length === 0 ? '--' : '!!'), ps.length === 0 ? '服务进程 0 个' :
    ps.length === 1 ? `服务进程 1 个 PID ${ps[0].pid}（${srcDirOf(ps[0].cmd) || '?'}）` :
      `服务进程 ${ps.length} 个（多实例会打架！）: ${ps.map(p => p.pid).join(',')}`);
  // 任务
  j.tasks = {};
  for (const name of [TASK.svc, TASK.hot, TASK.keep]) {
    const i = taskInfo(name); j.tasks[name] = i;
    if (!i.exists) P('!!', `任务 ${name}: 未注册（管理中心 → 安装）`);
    else {
      const same = i.src ? rootNormCmp(i.src, ROOT) : null;
      P(same === false ? '!!' : 'OK', `任务 ${name}: ${i.state || '?'} → ${i.src || i.runLine}${same === false ? '  ⚠指向别的副本' : ''}`);
    }
  }
  // 防火墙
  const fwMiss = FW_RULES.filter(([n]) => !firewallHas(n));
  j.firewallMissing = fwMiss.map(f => f[0]);
  P(fwMiss.length ? '!!' : 'OK', fwMiss.length ? `防火墙缺规则: ${fwMiss.map(f => f[0]).join(', ')}（局域网设备连不进来；安装可补）` : '防火墙 4 条规则齐全（53/80/443 放行局域网）');
  // 热点
  const hs = hotspotStatus(); j.hotspot = hs;
  const drvs = wlanDrivers(); const supp = drvs.filter(d => d.supported);
  P(hs.started ? 'OK' : '--', hs.started ? `热点运行中: ${hs.ssid}（客户端 ${hs.clients}）` : '热点未启动');
  // 热点该开没开 = 局域网设备全体断网（平板"网络错误"第一嫌疑）：NIC 已配/有网卡时主动提示
  if (!hs.started && supp.length && c.cfg && c.cfg.relay && c.cfg.relay.hotspot && (c.cfg.relay.hotspot.nic || c.cfg.relay.hotspot.ssid)) {
    P('!!', `热点未启动但 relay.hotspot 已配置（${c.cfg.relay.hotspot.ssid || '默认SSID'} / nic=${c.cfg.relay.hotspot.nic || '自动'}）—— 局域网设备(平板等)此刻连不上网！ 菜单[5]开热点 或 管理台「开热点」`);
    j.hotspotShouldRun = true;
  }
  if (supp.length) P('OK', `无线网卡 ${supp.map(d => d.name + (d.supported ? '✓' : '✗')).join(' / ')} 承载网络支持`);
  else if (drvs.length) P('!!', `无线网卡 ${drvs.map(d => d.name).join('/')} 驱动不支持承载网络（或驱动太老）`);
  else P('!!', '未检测到无线网卡（USB 网卡插好了吗？）');
  // 别的 DHCP 抢答（路由器没改 DNS/关 DHCP，或热点网段与路由器桥接）→ 设备拿到错网关/错 DNS，拦截失效
  try {
    const rf = path.join(ROOT, 'storage', 'dhcp-rivals.json');
    const ro = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const ks = Object.keys(ro).filter(k => Date.now() - (ro[k].t || 0) < 14 * 86400000);
    if (ks.length) P('!!', `局域网有别的 DHCP 在抢答（${ks.slice(0, 3).map(k => (ro[k].ip || '?') + '←' + k.slice(0, 8)).join(', ')}${ks.length > 3 ? ' 等' + ks.length + '台' : ''}）—— 设备可能拿到错网关/错 DNS 导致拦截失效；教程「第 1 步:改路由器」（路由器 DHCP 改为 DNS 指向本机，或关掉路由器 DHCP）`);
  } catch {}
  // 冲突
  const cf = conflicts(); j.conflicts = { foreign: cf.foreign.length, copies: cf.copies.map(c2 => c2.dir) };
  if (cf.foreign.length) P('!!', `发现 ${cf.foreign.length} 个别的副本被任务/进程引用: ${cf.foreign.map(f => f.dir).join(' | ')} —— 管理中心 → 冲突治理 归位`);
  else P('OK', '无副本冲突（任务与进程都指向本文件夹）');
  const bad = lines.filter(l => l.startsWith('[!!]')).length;
  j.verdict = bad === 0 ? 'ALL-OK' : `${bad} 项待修`;
  P(bad === 0 ? 'OK' : '!!', `体检结论: ${j.verdict}${bad ? '（按上面 [!!] 逐条处理：菜单“安装”能修大部分）' : ''}`);
  return { text: lines.join('\n'), json: j, bad };
}
function rootNormCmp(a, b) {
  const n = p => { try { return path.resolve(p).toLowerCase().replace(/[\\/]+$/, ''); } catch { return String(p || '').toLowerCase(); } };
  return n(a) === n(b);
}

/* --------------------------------------------------------------- 可视化台 */
function loadMgmtHtml() {
  const p = path.join(ROOT, 'public', 'mgmt.html');
  try { return fs.readFileSync(p, 'utf8'); } catch {
    return `<!doctype html><meta charset="utf-8"><title>管理台</title><body style="font-family:sans-serif"><h3>public\\mgmt.html 缺失</h3><p>把整个文件夹（含 public 目录）一起拷贝。</p></body>`;
  }
}
async function serve(o) {
  o = o || {};
  let port = MGMT_PORT_BASE;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj, type) => {
      const body = type === 'text' ? obj : JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': (type === 'text' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'), 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const readBody = () => new Promise(r2 => {
      const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => { try { r2(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch { r2(null); } });
    });
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, loadMgmtHtml(), 'text');
      if (req.method === 'GET' && (u.pathname === '/api/status' || u.pathname === '/api/status2')) {
        const st = await check({});
        return send(200, { text: st.text, json: st.json, bad: st.bad }, 'json');
      }
      if (req.method === 'GET' && u.pathname === '/api/config') {
        const c = loadCfg();
        return send(200, { ok: !!c.cfg, cfg: c.cfg, error: c.error || '', src: c.src, fallback: !!c.fallback, admin: isAdmin() }, 'json');
      }
      if (req.method === 'POST' && u.pathname === '/api/config') {
        const b = await readBody();
        if (!b || typeof b.cfg !== 'object' || !b.cfg) return send(400, { ok: false, msg: '请求体需为 {cfg:{...}}' });
        const before = loadCfg().cfg;
        // 合并保留：只覆盖白名单顶层键，防页面丢字段把整份配置写残
        const allow = ['sinkholeDomain', 'blockSubdomains', 'answerIP', 'answerBySource', 'dnsPort', 'upstreamDNS', 'allowFromCIDR', 'sinkExtraDomains', 'httpPort', 'httpsPort', 'target', 'cert', 'relay'];
        const merged = Object.assign({}, before || {});
        for (const k of allow) if (k in b.cfg) merged[k] = b.cfg[k];
        if (b.cfg._说明) merged._说明 = b.cfg._说明;
        try {
          saveCfg(merged);
          const chk = loadCfg();
          return send(200, { ok: !!chk.cfg && !chk.fallback, src: chk.src });
        } catch (e) { return send(500, { ok: false, msg: String(e.message) }); }
      }
      if (req.method === 'GET' && u.pathname === '/api/logs') {
        const f = String(u.searchParams.get('file') || 'logs/sinkhole.log').replace(/[\\/]/g, '/');
        if (f.indexOf('..') !== -1 || !/^logs\//.test(f)) return send(400, { ok: false, msg: '仅允许 logs/ 下的文件' });
        return send(200, { ok: true, file: f, text: tail(f, +(u.searchParams.get('lines') || 200)) }, 'json');
      }
      if (req.method === 'GET' && u.pathname === '/api/visits') {
        // 局域网访问记录（中继站 storage/visits.json 直读；中继站进程才记录，本台只读展示）
        const n = Math.max(10, Math.min(1000, +(u.searchParams.get('n') || 100)));
        const c = loadCfg();
        const on = !c.cfg || !c.cfg.relay || c.cfg.relay.visits !== false;
        const cap = (c.cfg && c.cfg.relay && +c.cfg.relay.visitsMax) || 1000;
        let rows = []; let total = 0; let err = '';
        try {
          const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage', 'visits.json'), 'utf8'));
          rows = Array.isArray(v) ? v : [];
          total = rows.length;
          rows = rows.slice(-n).reverse();
        } catch (e) { err = String(e.message || e); }
        return send(200, { ok: true, on, cap, total, rows, err }, 'json');
      }
      if (req.method === 'GET' && u.pathname === '/api/conflicts') return send(200, conflicts(), 'json');
      if (req.method === 'POST' && u.pathname === '/api/action') {
        const b = await readBody() || {};
        const act = String(b.action || '');
        const needAdmin = ['start', 'install', 'uninstall', 'fix', 'hotspot-on', 'hotspot-off', 'restart'].indexOf(act) !== -1;
        if (needAdmin && !isAdmin()) return send(200, { ok: false, needAdmin: true, msg: '此操作需要管理员：请关掉本台，右键 管理中心.bat → 以管理员身份运行' });
        switch (act) {
          case 'start': return send(200, await startSvc(), 'json');
          case 'stop': return send(200, await stopSvc().then(s => ({ ok: true, ...s })), 'json');
          case 'restart': { await stopSvc(); return send(200, await startSvc(), 'json'); }
          case 'hotspot-on': return send(200, await hotspotStart({}), 'json');
          case 'hotspot-off': return send(200, await hotspotStop(), 'json');
          case 'install': return send(200, { ok: true, result: installAll() }, 'json');
          case 'uninstall-dry': return send(200, await uninstall({ dry: true }), 'json');
          case 'uninstall': return send(200, await uninstall({}), 'json');
          case 'fix': return send(200, await conflictsFix(), 'json');
          default: return send(400, { ok: false, msg: '未知 action: ' + act });
        }
      }
      send(404, { ok: false, msg: 'not found' }, 'json');
    } catch (e) { send(500, { ok: false, msg: String(e.message) }); }
  });
  const listen = p => new Promise((res, rej) => {
    server.once('error', e => rej(e));
    server.listen(p, '127.0.0.1', () => res(p));
  });
  for (let i = 0; i < 10; i++) {
    try { port = await listen(MGMT_PORT_BASE + i); break; }
    catch (e) { if (i === 9) { console.error('28790-28799 全被占用'); return 1; } }
  }
  const urlStr = `http://127.0.0.1:${port}/`;
  console.log(`可视化管理台已启动: ${urlStr}  （只监听本机；Ctrl+C 关闭）`);
  if (o.open) {
    try { const c = cp.spawn('cmd', ['/c', 'start', '', urlStr], { windowsHide: true, stdio: 'ignore' }); c.unref(); } catch {}
  }
  return new Promise(() => {}); // 常驻
}

/* --------------------------------------------------------------- 交互菜单 */
async function menu() {
  const scripted = process.env.MGMT_MENU_STDIN; // E2E 逃生口：文件按行喂菜单选择，跑完退出
  if (!process.stdin.isTTY && !scripted) {
    // 无交互终端（管道/重定向）不能进问答循环——否则 EOF 会空转刷屏
    console.log('（菜单需要交互终端；常用命令：）\n' +
      '  node mgmt.js check            环境自检\n' +
      '  node mgmt.js start|stop|restart   服务启停\n' +
      '  node mgmt.js hotspot on|off|status  热点开关/状态\n' +
      '  node mgmt.js install          安装/修复注册项\n' +
      '  node mgmt.js conflicts [--fix]    冲突检测/归位\n' +
      '  node mgmt.js uninstall [--dry|--purge]  卸载(演练/连文件夹)\n' +
      '  node mgmt.js serve [--open]   可视化管理台');
    return 0;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (scripted) {
    // 测试模式：菜单问答改由脚本行驱动（自动答题到 0 退出），供 E2E 冒烟验证分发逻辑
    let lines = [];
    try { lines = fs.readFileSync(scripted, 'utf8').split(/\r?\n/).filter(x => x.length); } catch {}
    let li = 0;
    const clean = s => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    console.log = (...a) => process.stdout.write(a.map(clean).join(' ') + '\n');
    console.error = console.log;
    rl.question = (q, cb) => {
      process.stdout.write(clean(q));
      const v = li < lines.length ? lines[li++] : '0';
      if (cb) cb(v);
      return Promise.resolve(v);
    };
  }
  const ask = q => new Promise(r => { rl.question(q, r); rl.once('close', () => r('0')); });
  const big = [
    ['1', '环境自检（节点/权限/配置/端口/任务/热点 一键体检）'],
    ['2', '启动服务'], ['3', '停止服务'], ['4', '重启服务'],
    ['5', '开热点（SoftAP）'], ['6', '关热点'], ['7', '热点状态'],
    ['8', '安装/修复（注册 3 任务 + 防火墙，全部指向本文件夹）'],
    ['9', '冲突治理（发现并归位“别的副本”的任务/进程）'],
    ['a', '打开可视化管理台（网页配置/状态/日志）'],
    ['u', '一键卸载（默认保留文件；子菜单可选删文件夹）'],
    ['0', '退出']
  ];
  for (; ;) {
    console.log('\n======== 中继站管理中心（便携版，无 exe）========');
    console.log(`本文件夹: ${ROOT}`);
    console.log(`管理员: ${isAdmin() ? '是' : '否（安装/卸载/热点会提示 UAC）'}   Node: ${process.versions.node}`);
    for (const [k, t] of big) console.log(`  [${k}] ${t}`);
    const a = (await ask('选择> ')).trim().toLowerCase();
    try {
      if (a === '0') break;
      else if (a === '1') { const r = await check({}); console.log('\n' + r.text); }
      else if (a === '2') { console.log(await startSvc().then(r => r.msg + (r.log ? '\n' + r.log : ''))); }
      else if (a === '3') { const s = await stopSvc(); console.log(`发现 ${s.found}，已停 ${s.killed.length}，残留 ${s.remain}`); }
      else if (a === '4') { await stopSvc(); const r = await startSvc(); console.log(r.msg + (r.log ? '\n' + r.log : '')); }
      else if (a === '5') { const r = await hotspotStart({}); console.log(r.log ? r.log.join('\n') : r.msg || ''); if (!r.ok) console.log('失败原因见上'); }
      else if (a === '6') { const r = await hotspotStop(); console.log(r.msg); }
      else if (a === '7') { const s = hotspotStatus(); console.log(s.started ? `运行中: ${s.ssid}，客户端 ${s.clients}` : '未启动'); console.log(wlanIfaces().map(i => `  ${i.name}: ${i.state} ${i.ssid} ${i.signal >= 0 ? i.signal + '%' : ''}`).join('\n')); }
      else if (a === '8') {
        const r = installAll();
        r.tasks.forEach(t => console.log(`  任务 ${t.name}: ${t.ok ? 'OK' : '失败'}${t.repointed ? `（已从 ${t.before} 归位到本文件夹）` : ''}${t.ok ? '' : '  ' + t.note}`));
        r.firewall.forEach(f => console.log(`  防火墙 ${f.name}: ${f.ok ? 'OK' : '失败 ' + f.note}`));
        r.warn.forEach(w => console.log('  [提醒] ' + w));
      }
      else if (a === '9') {
        const rep = conflicts();
        rep.items.forEach(i => console.log(`  [${i.status === 'ok' ? 'OK' : (i.status === 'foreign' ? '!!' : (i.status === 'missing' ? '!!' : '?'))}] ${i.kind} ${i.name}: ${i.detail}`));
        if (rep.foreign.length) {
          const y = (await ask(' 归位到本文件夹并停掉别的副本服务？(y/N) ')).trim().toLowerCase();
          if (y === 'y') { const r = await conflictsFix(); r.steps.forEach(s => console.log('  ' + s)); }
        } else console.log('  无冲突。');
      }
      else if (a === 'a') { const r = await serve({ open: true }); return r; }
      else if (a === 'u') {
        console.log('  [1] 演练（只列清单不执行）  [2] 卸载（保留文件）  [3] 卸载并删除本文件夹  [0] 返回');
        const u = (await ask('  选择> ')).trim();
        if (u === '1') { const r = await uninstall({ dry: true }); console.log(JSON.stringify(r.would, null, 2)); }
        else if (u === '2' || u === '3') {
          const y = (await ask(u === '3' ? ' 确认删除本文件夹及全部数据？(输入 yes) ' : ' 确认卸载（停服务/删3任务/防火墙/停热点）？(y/N) ')).trim().toLowerCase();
          const confirmed = u === '3' ? y === 'yes' : y === 'y';
          if (confirmed) {
            const r = await uninstall(u === '3' ? { purge: true } : {});
            (r.steps || []).forEach(s2 => console.log(`  ${s2.name}: ${s2.detail}`));
            console.log('  ' + (r.msg || ''));
            if (r.needAdmin) console.log('  → 请右键 管理中心.bat 以管理员身份运行后重试');
            if (u === '3' && r.ok) { console.log('本文件夹将在数秒后自动删除，窗口可关闭。'); break; }
          } else console.log('  已取消');
        }
      }
      else console.log('无效选择');
    } catch (e) { console.log('操作异常: ' + (e.stack || e.message)); }
  }
  rl.close();
  return 0;
}

/* ------------------------------------------------------------------ 入口 */
(async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || 'menu').toLowerCase();
  const has = f => argv.indexOf(f) !== -1;
  try {
    if (cmd === 'menu') process.exit(await menu());
    else if (cmd === 'check') {
      const r = await check({});
      if (has('--json')) console.log(JSON.stringify(r.json, null, 2)); else console.log(r.text);
      process.exit(r.bad ? 1 : 0);
    }
    else if (cmd === 'status') {
      const r = await check({});
      if (has('--json')) console.log(JSON.stringify(r.json, null, 2)); else console.log(r.text);
      process.exit(0);
    }
    else if (cmd === 'start') { const r = await startSvc(); console.log(r.msg); if (r.log) console.log(r.log); process.exit(r.ok ? 0 : 1); }
    else if (cmd === 'stop') { const s = await stopSvc(); console.log(`发现 ${s.found}，已停 ${s.killed.length}，残留 ${s.remain}`); process.exit(s.remain ? 1 : 0); }
    else if (cmd === 'restart') { await stopSvc(); const r = await startSvc(); console.log(r.msg); if (r.log) console.log(r.log); process.exit(r.ok ? 0 : 1); }
    else if (cmd === 'hotspot') {
      const sub = (argv[1] || '').toLowerCase();
      const getOpt = f => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
      if (sub === 'off' || sub === 'stop') { const r = await hotspotStop(); console.log(r.msg); process.exit(r.ok ? 0 : 1); }
      if (sub === 'status') { const s = hotspotStatus(); console.log(s.started ? `Started ${s.ssid} clients=${s.clients}` : 'Not started'); process.exit(s.started ? 0 : 3); }
      const opts = { ssid: getOpt('--ssid'), key: getOpt('--key'), staSsid: getOpt('--stassid'), staKey: getOpt('--stakey') };
      let r = await hotspotStart(opts);
      // 开机自动重试:USB 网卡枚举比开机任务慢(实测 10-16 开机任务 Last Result=1,热点没起来→全屋断网)
      if (has('--retry')) {
        for (let att = 2; att <= 4 && !r.ok; att++) {
          await new Promise(res2 => setTimeout(res2, 15000));
          (r.log = r.log || []).push(`— 开机自动重试 第${att}次(等网卡枚举/驱动就绪) —`);
          r = await hotspotStart(opts);
        }
      }
      (r.log || []).forEach(m => console.log(m));
      if (!r.ok && !(r.log || []).length) console.log('热点启动失败');
      process.exit(r.ok ? 0 : 1);
    }
    else if (cmd === 'install') {
      if (!isAdmin()) { console.log('需要管理员：请用 管理中心.bat（会请求 UAC）或右键管理员运行本命令'); process.exit(1); }
      const r = installAll();
      r.tasks.forEach(t => console.log(`任务 ${t.name}: ${t.ok ? 'OK' : '失败'} ${t.repointed ? `(归位 ${t.before} → 本文件夹)` : ''} ${t.ok ? '' : t.note}`));
      r.firewall.forEach(f => console.log(`防火墙 ${f.name}: ${f.ok ? 'OK' : '失败 ' + f.note}`));
      r.warn.forEach(w => console.log('[提醒] ' + w));
      process.exit(r.tasks.every(t => t.ok) ? 0 : 1);
    }
    else if (cmd === 'conflicts') {
      if (has('--fix')) { const r = await conflictsFix(); r.steps.forEach(s => console.log(s)); process.exit(0); }
      const rep = conflicts();
      rep.items.forEach(i => console.log(`[${i.status === 'ok' ? 'OK' : '!!'}] ${i.kind} ${i.name}: ${i.detail}`));
      console.log(rep.clean ? '结论: 无副本冲突' : `结论: ${rep.foreign.length} 个外来副本 → node mgmt.js conflicts --fix 归位`);
      process.exit(rep.clean ? 0 : 1);
    }
    else if (cmd === 'uninstall') {
      const r = await uninstall({ dry: has('--dry'), purge: has('--purge'), cert: has('--cert') });
      (r.steps || []).forEach(s => console.log(`${s.name}: ${s.detail}`));
      console.log(r.msg || (r.dry ? '演练完成（未执行）' : ''));
      process.exit(r.ok ? 0 : 1);
    }
    else if (cmd === 'serve') process.exit(await serve({ open: has('--open') }));
    else { console.log('用法: node mgmt.js [menu|check|status|start|stop|restart|hotspot on|off|status|install|conflicts [--fix]|uninstall [--dry|--purge|--cert]|serve [--open]]'); process.exit(2); }
  } catch (e) {
    console.error('FATAL: ' + (e.stack || e.message));
    process.exit(1);
  }
})();
