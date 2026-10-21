'use strict';
/* ============================================================================
 * 保活守护 keepalive.js —— 由计划任务 sinkhole-keepalive 每 5 分钟调起（node 版）
 * 为什么不用 keep-alive.ps1：Win7 自带 PS2.0 没有 Resolve-DnsName/Get-CimInstance，
 * PS 版在 Win7 上静默失效；本脚本零依赖 node，Win7..Win11 一致行为。
 *
 * 三种病都治：
 *   ① 0 实例        → 服务没了 → 重启任务
 *   ② 多实例打架    → 端口避让把栈切开（一个占 53/80/443/28791，其余 28792+ → 一半功能哑）
 *                     → 连续 2 轮 >1 实例（跨 5 分钟，避开暖机误判）→ 全杀 + 重启任务
 *   ③ 单实例但卡死  → 真发 DNS 查询探活，连续 2 轮无应答（>5 分钟）→ 重启任务
 * 状态记 logs/keepalive.state.json（防膨胀：一切正常时不写日志，只清状态）。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const dgram = require('dgram');

const ROOT = __dirname;
const SVC_FLAG = '--svc-sinkhole';
const TASK = 'iflytek-sinkhole';
const STATE = path.join(ROOT, 'logs', 'keepalive.state.json');

function slp(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) {
  try {
    const d = path.join(ROOT, 'logs');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'keepalive.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState(s) {
  try {
    const d = path.join(ROOT, 'logs');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(STATE + '.tmp', JSON.stringify(s), 'utf8');
    fs.renameSync(STATE + '.tmp', STATE);
  } catch {}
}
function svcProcs() {
  // 与 mgmt.js 同款三级回退：CIM → WMI → wmic（Win7/PS2 走后两条）
  const ps = `$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*${SVC_FLAG}*' }); if(-not $p){ $p = @(Get-WmiObject Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*${SVC_FLAG}*' }) }; $p | ForEach-Object { "$($_.ProcessId)~|~$($_.CommandLine)" }`;
  let r = {};
  try {
    r = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'buffer', timeout: 30000 });
  } catch { r = { status: -1 }; }
  if (r.status === 0) {
    const out = [];
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^(\d+)~\|~(.*)$/);
      // 严格双条件：标记 + index.js（防脚本文本自匹配误杀）
      if (m && m[2].indexOf(SVC_FLAG) !== -1 && /index\.js/i.test(m[2])) out.push({ pid: +m[1] });
    }
    return out;
  }
  try {
    const w = cp.spawnSync('wmic', ['process', 'where', "Name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:list'],
      { windowsHide: true, encoding: 'buffer', timeout: 30000 });
    const out = []; let cur = null;
    const txt = String(w.stdout || '');
    for (const line of txt.split(/\r?\n/)) {
      const m1 = line.match(/^CommandLine=(.*)$/); if (m1) { cur = m1[1].trim(); continue; }
      const m2 = line.match(/^ProcessId=(\d+)$/); if (m2 && cur) { if (cur.indexOf(SVC_FLAG) !== -1 && /index\.js/i.test(cur)) out.push({ pid: +m2[1] }); cur = null; }
    }
    return out;
  } catch { return null; } // 全链失败=探测不可用，宁可不动也不误杀
}
function dnsProbe(ms) {
  return new Promise(res => {
    let done = false;
    const ok = v => { if (!done) { done = true; res(v); } };
    const s = dgram.createSocket('udp4');
    const q = Buffer.from([0x7a, 0x11, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      7, 105, 102, 108, 121, 116, 101, 107, 3, 99, 111, 109, 0, 0, 1, 0, 1]);
    try {
      s.send(q, 53, '127.0.0.1');
      const t = setTimeout(() => { try { s.close(); } catch {} ok(false); }, ms || 2500);
      s.on('message', () => { clearTimeout(t); try { s.close(); } catch {} ok(true); });
      s.on('error', () => { clearTimeout(t); ok(false); });
    } catch { ok(false); }
  });
}
function sch(cmds) { // schtasks 封装
  try { return cp.spawnSync('schtasks', cmds, { windowsHide: true, encoding: 'buffer', timeout: 20000 }); } catch { return { status: -1 }; }
}
async function restartTask(why, st) {
  const ps = svcProcs() || [];
  for (const p of ps) {
    try { cp.spawnSync('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true, timeout: 10000 }); } catch {}
  }
  await slp(2000);
  sch(['/end', '/tn', TASK]);
  await slp(1000);
  sch(['/run', '/tn', TASK]);
  log(`${why} → 已清实例(${ps.length} 个)并重启任务`);
  saveState({}); // 复位
}
(async function main() {
  const st = loadState();
  const ps = svcProcs();
  if (ps === null) { log('进程探测三级链全失败(PS+wmic 均不可用)，本轮跳过'); return; }

  if (ps.length === 0) {
    st.zeroFails = (st.zeroFails || 0) + 1;
    if (st.zeroFails >= 1) return restartTask(`服务不在线(0 实例,第${st.zeroFails}轮)`, st);
    return;
  }

  if (ps.length > 1) {
    if (!st.multiSince) { st.multiSince = Date.now(); saveState(st); return; } // 首轮记录,给暖机留时间
    if (Date.now() - st.multiSince > 90 * 1000) {
      return restartTask(`多实例打架(${ps.length} 个,持续 ${Math.round((Date.now() - st.multiSince) / 1000)}s)`, st);
    }
    return;
  }

  // 单实例：真探活（53 占着但事件循环卡死的老 bug 就是这么漏的）
  st.multiSince = null;
  const alive = await dnsProbe(2500);
  if (alive) {
    if (st.dnsFails || st.zeroFails) { saveState({}); } // 恢复正常 → 清状态(不写日志防膨胀)
    return;
  }
  st.dnsFails = (st.dnsFails || 0) + 1;
  saveState(st);
  if (st.dnsFails >= 2) return restartTask(`单实例 53 连续 ${st.dnsFails} 轮无应答(事件循环卡死)`, st);
  log(`单实例 53 无应答(第 ${st.dnsFails} 轮,连续 2 轮才重启)`);
})().catch(e => { log('FATAL ' + (e.message || e)); process.exit(1); });
