'use strict';
/**
 * 局域网文件中继站(Relay) —— 零第三方依赖
 * 由 sinkhole 的 web-proxy 反代接入(经被拦截域名到达)
 *  API:
 *   GET  /                中继站页面(public/index.html)
 *   POST /api/upload      请求体=文件原始字节,头 x-file-name=<encodeURIComponent(文件名)>
 *   GET  /api/files       文件列表 JSON
 *   GET  /f/:id           下载(支持 Range 断点续传;?inline=1 内联预览)
 *   DELETE /api/files/:id 删除
 *   GET|PUT /api/note     共享文字便签(文字中继)
 *   WS  /ws/chat          局域网聊天室(?name=昵称,广播+历史+在线名单)
 *   POST /api/chat/clear  清空聊天记录
 *   GET|POST /p/<url>     网页转发浏览(抓取目标页并改写链接,可逐页点入内页)
 *   GET  /auth/login (GET/POST=表单) /api/auth/login (JSON)  账号登录;GET /auth/logout 登出
 *   GET  /api/upload/status?key=<fileKey>                     续传断点查询(返回 offset)
 *   POST /api/upload  头 x-file-name/x-upload-key/x-upload-offset 支持断点续传(从 offset 追加)
 *   GET  /api/info        �点信息(含 admin/auth 状态)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { URL: NodeURL } = require('url'); // eslint-disable-line no-unused-vars

const root = __dirname;
const filesDir = path.join(root, 'storage', 'files');
const metaPath = path.join(root, 'storage', 'meta.json');
const tmpPrefix = '.tmp-';
const NOTE_MAX = 1024 * 1024; // 便签上限 1 MiB
const NAME_MAX = 180;

let R = null; // config.relay
let log = () => {};
let meta = null;

/* ---------- 元数据存储 ---------- */

function ensureDirs() {
  fs.mkdirSync(filesDir, { recursive: true });
}

function loadMeta() {
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = { files: {}, note: { text: '', updatedAt: 0, updatedBy: '' } };
  }
  if (!meta.files || typeof meta.files !== 'object') meta.files = {};
  if (!meta.note) meta.note = { text: '', updatedAt: 0, updatedBy: '' };
  // 清理:元数据里文件已丢失的条目;残留的上传中临时文件(>24h)
  for (const id of Object.keys(meta.files)) {
    if (!fs.existsSync(path.join(filesDir, id))) delete meta.files[id];
  }
  const now = Date.now();
  for (const f of fs.readdirSync(filesDir)) {
    if (f.startsWith(tmpPrefix)) {
      try {
        const st = fs.statSync(path.join(filesDir, f));
        if (now - st.mtimeMs > 24 * 3600e3) fs.unlinkSync(path.join(filesDir, f));
      } catch {}
    }
  }
  saveMeta(true);
}

let saveTimer = null;
function saveMeta(now) {
  const doWrite = () => {
    saveTimer = null;
    try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); }
    catch (e) { log(`[RELAY] 写 meta.json 失败: ${e.message}`); }
  };
  if (now) { if (saveTimer) clearTimeout(saveTimer); return doWrite(); }
  if (saveTimer) return;
  saveTimer = setTimeout(doWrite, 250);
}

/* ---------- 工具 ---------- */

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const ip = (xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  return ip.replace(/^::ffff:/, '');
}

function sanitizeName(raw) {
  let name = String(raw || '').trim();
  try { name = decodeURIComponent(name); } catch {}
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').slice(0, NAME_MAX);
  return name || '未命名文件';
}

function disposition(name, inline) {
  const enc = encodeURIComponent(name).replace(/'/g, '%27').replace(/"/g, '%22');
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${enc}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
  '.csv': 'text/csv; charset=utf-8', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook',
  '.7z': 'application/x-7z-compressed', '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream', '.ipa': 'application/octet-stream',
};
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function checkToken(req) {
  if (!R.token) return true;
  return req.headers['x-relay-token'] === R.token;
}

/* ---------- 管理员判定 ----------
 * 本机来源(127.0.0.1 / 本机任一网卡 IP)= 管理员:可删文件、清聊天(审核)。
 * 其它设备 = 普通用户:上传/下载/聊天/便签不受限,但无删除/清空权限。
 * 配置 relay.token 后,持正确 token 的设备也视同管理员。
 * 经 web-proxy 转发的请求取 x-forwarded-for 判定真实来源,防"人人都是本机"。
 */
function isAdmin(req) {
  const local = new Set(['127.0.0.1', '::1', 'localhost']);
  try {
    for (const list of Object.values(os.networkInterfaces()))
      for (const ni of list || []) if (ni && ni.address) local.add(ni.address.replace(/^::ffff:/, ''));
  } catch {}
  return local.has(clientIp(req));
}
function checkTokenStrict(req) {
  return !!R.token && req.headers['x-relay-token'] === R.token;
}
/* ---------- 账号登录会话(配置 relay.auth) ----------
 * 权限范围与流量配额(storage/roles.json + storage/traffic.json):
 *  roles.json  {"__version":1,"defaultPerms":[...],"roles":{角色:{perms,monthlyQuotaMB}}}
 *              缺失/损坏自动回默认:全员 upload/download/preview/chat/web,quota 0=不限
 *  traffic.json {用户:{y:2026,m:10,up:字节,down:字节}} 按月落盘,月变自动归零;
 *              追踪键 = 已登录账号,本机/token 免登录访问记 "__local__"(计数不设限)
 *  接口:/api/admin/roles GET|POST、/api/admin/traffic GET、/admin 管理页(全部 canAdmin)
 */
const AUTH = () => (R && R.auth) || {};
const SESSION_DAYS = 30;
const sessionsPath = path.join(root, 'storage', 'sessions.json');
const rolesPath = path.join(root, 'storage', 'roles.json');
const trafficPath = path.join(root, 'storage', 'traffic.json');
const PERMS = ['upload', 'download', 'preview', 'chat', 'web', 'delete', 'admin'];
const DEFAULT_PERMS = ['upload', 'download', 'preview', 'chat', 'web'];
let rolesCfg = null;   // storage/roles.json 的规范化视图(见 loadRoles)
let traffic = {};      // storage/traffic.json:用户 -> {y,m,up,down}
let sessions = {};          // sid -> { user, exp }
let sessionsTimer = null;
function loadSessions() {
  try { const j = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')); if (j && typeof j === 'object') sessions = j; } catch {}
  pruneSessions();
}
function pruneSessions() {
  const now = Date.now();
  for (const k of Object.keys(sessions)) if (!sessions[k] || sessions[k].exp < now) delete sessions[k];
}
function saveSessions(now) {
  const w = () => { try { pruneSessions(); fs.writeFileSync(sessionsPath, JSON.stringify(sessions)); } catch {} };
  if (now) { if (sessionsTimer) { clearTimeout(sessionsTimer); sessionsTimer = null; } return w(); }
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(() => { sessionsTimer = null; w(); }, 400);
}
function sessionOf(req) {
  const m = /(?:^|;\s*)relay_sid=([0-9a-f]{32})/.exec(String(req.headers.cookie || ''));
  if (!m) return null;
  const s = sessions[m[1]];
  if (!s) return null;
  if (s.exp < Date.now()) { delete sessions[m[1]]; return null; }
  return { sid: m[1], user: s.user };
}
function authAccounts() { const a = AUTH().accounts; return a && typeof a === 'object' ? a : {}; }
function roleOf(user) { const r = AUTH().roles; return (r && r[user]) || 'user'; }
function pwHash(pw) { return crypto.createHash('sha256').update(String(pw), 'utf8').digest('hex'); }
function verify(user, pass) {
  const acc = authAccounts();
  if (!user || !(user in acc)) return false;
  try { return crypto.timingSafeEqual(Buffer.from(pwHash(acc[user]), 'utf8'), Buffer.from(pwHash(pass), 'utf8')); } catch { return false; }
}
function loginUser(user, pass) {
  if (!AUTH().enabled || !verify(user, pass)) return null;
  const sid = crypto.randomBytes(16).toString('hex');
  sessions[sid] = { user, exp: Date.now() + SESSION_DAYS * 86400e3 };
  saveSessions();
  return { sid, user, role: roleOf(user) };
}
function requireAuth(req) { return !AUTH().enabled || !!sessionOf(req) || isAdmin(req); } // 本机来源免登录直入(管理员)
function canAdmin(req) {
  if (isAdmin(req) || checkTokenStrict(req)) return true;
  const s = sessionOf(req);
  if (!s) return false;
  const role = roleOf(s.user);
  return role === 'admin' || permsOfRole(role).includes('admin'); // 自定义身份组授 admin 权限同样可进管理
}

/* ---------- 角色权限与流量配额 ---------- */
function loadRoles() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(rolesPath, 'utf8')); } catch {}
  if (!j || typeof j !== 'object') j = {};
  const dp = Array.isArray(j.defaultPerms) ? j.defaultPerms.filter((p) => PERMS.includes(p)) : null;
  const src = (j.roles && typeof j.roles === 'object') ? j.roles : {};
  const cleaned = {};
  for (const [rn, rv] of Object.entries(src)) {
    if (!rv || typeof rv !== 'object') continue;
    const q = Number(rv.monthlyQuotaMB);
    cleaned[rn] = {
      perms: Array.isArray(rv.perms) ? rv.perms.filter((p) => PERMS.includes(p)) : null, // null=跟随 defaultPerms
      monthlyQuotaMB: Number.isFinite(q) && q >= 0 ? q : 0,                                // 0=不限
    };
  }
  rolesCfg = { defaultPerms: dp && dp.length ? dp : DEFAULT_PERMS.slice(), roles: cleaned };
  return rolesCfg;
}
let rolesTimer = null;
function saveRoles() {
  if (rolesTimer) return;
  rolesTimer = setTimeout(() => {
    rolesTimer = null;
    try { fs.writeFileSync(rolesPath, JSON.stringify(rolesCfg, null, 2)); } catch {}
  }, 200);
}
function permsOfRole(role) {
  if (role === 'admin') return PERMS.slice(); // 内置管理员组=全权限(不可被 roles.json 削权)
  const r = rolesCfg.roles[role];
  return r && r.perms ? r.perms : rolesCfg.defaultPerms;
}
function quotaOfRole(role) {
  if (role === 'admin') return 0;
  const r = rolesCfg.roles[role];
  return r ? r.monthlyQuotaMB : 0; // 未配置的角色(=任意自定义角色名)不设限
}
function loadTraffic() {
  try { const j = JSON.parse(fs.readFileSync(trafficPath, 'utf8')); if (j && typeof j === 'object') traffic = j; } catch {}
  pruneTraffic();
}
function pruneTraffic() {
  const now = new Date();
  for (const [u, t] of Object.entries(traffic)) {
    if (!t || t.y !== now.getUTCFullYear() || t.m !== now.getUTCMonth() + 1) delete traffic[u];
  }
}
let trafficTimer = null;
function saveTraffic(now) {
  const w = () => { try { pruneTraffic(); fs.writeFileSync(trafficPath, JSON.stringify(traffic)); } catch {} };
  if (now) { if (trafficTimer) { clearTimeout(trafficTimer); trafficTimer = null; } return w(); }
  if (trafficTimer) return;
  trafficTimer = setTimeout(() => { trafficTimer = null; w(); }, 400);
}
/* 账号身份组写回 config.json(relay.auth.roles)——身份组归属仍在 config,权限/配额在 roles.json */
function saveConfigRoles(roles) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    if (!cfg.relay || typeof cfg.relay !== 'object') cfg.relay = {};
    if (!cfg.relay.auth || typeof cfg.relay.auth !== 'object') cfg.relay.auth = {};
    cfg.relay.auth.roles = roles;
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  } catch (e) { log(`[ADMIN] 写 config.json 失败: ${e.message}`); }
}
/* 当前请求的计量身份:已登录=账号;本机/token 免登录=__local__;其它=__ip:<地址> */
function trackUser(req) {
  const s = sessionOf(req);
  if (s) return s.user;
  return (isAdmin(req) || checkTokenStrict(req)) ? '__local__' : '__ip:' + clientIp(req);
}
function quotaStateOf(req) {
  if (!AUTH().enabled) return { quota: 0, up: 0, down: 0 }; // 未开登录=信任网络,不设限
  const s = sessionOf(req);
  if (isAdmin(req) || checkTokenStrict(req)) return { quota: 0, up: 0, down: 0 }; // 管理路径不设限
  const quota = s ? quotaOfRole(roleOf(s.user)) : 0;
  const t = traffic[trackUser(req)] || { up: 0, down: 0 };
  return { quota, up: t.up || 0, down: t.down || 0 };
}
/* 流量入账(上传/下载字节);超限时返回剩余可用量(正数),否则 null */
function addTraffic(req, field, bytes) {
  if (!(bytes > 0)) return null;
  const st = quotaStateOf(req);
  const used = (field === 'up' ? st.up : st.down) + bytes;
  const k = trackUser(req);
  if (!traffic[k]) traffic[k] = { y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() + 1, up: 0, down: 0 };
  traffic[k][field] = (traffic[k][field] || 0) + bytes;
  saveTraffic();
  if (st.quota > 0) {
    const total = st.up + st.down + bytes;
    if (total > st.quota * 1048576) return Math.max(0, st.quota * 1048576 - (st.up + st.down));
  }
  return null;
}
/* 权限判定:本机/token=全放行;已登录=按其角色;未开登录=全放行(信任网络) */
function hasPerm(req, perm) {
  if (isAdmin(req) || checkTokenStrict(req)) return true;
  if (!AUTH().enabled) return true;
  const s = sessionOf(req);
  if (!s) return false; // requireAuth 已拦未登录,到这里即缺权限
  return permsOfRole(roleOf(s.user)).includes(perm);
}
/* 连接建立时快照身份(聊天 WS 用);发消息时按当前 roles.json 动态判权限,收权限即时生效 */
function chatPerms(cli) {
  if (cli.isLocal) return PERMS.slice();                 // 本机/token 连接=全权限
  if (!AUTH().enabled) return DEFAULT_PERMS.slice();
  const s = cli.sid && sessions[cli.sid];
  if (!s || s.exp < Date.now()) return [];               // 会话已登出/过期
  return permsOfRole(roleOf(s.user));
}
/* /api/info 暴露的身份权限集 */
function permsOfReq(req) {
  if (isAdmin(req) || checkTokenStrict(req)) return PERMS.slice();
  if (!AUTH().enabled) return DEFAULT_PERMS.slice();
  const s = sessionOf(req);
  return s ? permsOfRole(roleOf(s.user)) : [];
}

/* ---------- API 处理 ---------- */

async function handleRolesPost(req, res) {
  if (!canAdmin(req)) return json(res, 403, { error: '仅管理员' });
  let buf;
  try { buf = await readBody(req, 64 * 1024); } catch { return json(res, 413, { error: '请求过大' }); }
  let j;
  try { j = JSON.parse(buf.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'JSON 不合法' }); }
  if (Array.isArray(j.defaultPerms)) {
    const dp = j.defaultPerms.filter((x) => PERMS.includes(x));
    rolesCfg.defaultPerms = dp.length ? dp : DEFAULT_PERMS.slice();
  }
  if (j.roles && typeof j.roles === 'object') {
    const out = {};
    for (const [rn, rv] of Object.entries(j.roles)) {
      if (!/^[\w一-龥.-]{1,32}$/.test(rn) || !rv || typeof rv !== 'object') continue;
      const q = Number(rv.monthlyQuotaMB);
      out[rn] = {
        perms: Array.isArray(rv.perms) ? rv.perms.filter((x) => PERMS.includes(x)) : null, // null=跟随默认权限
        monthlyQuotaMB: Number.isFinite(q) && q > 0 ? Math.min(q, 1000000) : 0,            // 0=不限
      };
    }
    rolesCfg.roles = out;
  }
  saveRoles();
  log(`[ADMIN] ${clientIp(req)} 更新身份组配置: roles=${Object.keys(rolesCfg.roles).join(',') || '(无)'}`);
  return json(res, 200, { ok: true, defaultPerms: rolesCfg.defaultPerms, roles: rolesCfg.roles });
}

async function handleTrafficReset(req, res) {
  if (!canAdmin(req)) return json(res, 403, { error: '仅管理员' });
  let buf;
  try { buf = await readBody(req, 16 * 1024); } catch { return json(res, 413, { error: '请求过大' }); }
  let j = {};
  try { j = JSON.parse(buf.toString('utf8') || '{}'); } catch {}
  if (j.user && traffic[j.user]) delete traffic[j.user];
  else traffic = {}; // 不带 user=全部清零
  saveTraffic(true);
  log(`[ADMIN] ${clientIp(req)} 清零流量统计: ${j.user || '(全部)'}`);
  return json(res, 200, { ok: true });
}

async function handleAccountsPost(req, res) {
  if (!canAdmin(req)) return json(res, 403, { error: '仅管理员' });
  let buf;
  try { buf = await readBody(req, 64 * 1024); } catch { return json(res, 413, { error: '请求过大' }); }
  let j;
  try { j = JSON.parse(buf.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'JSON 不合法' }); }
  const acc = authAccounts();
  const roles = AUTH().roles && typeof AUTH().roles === 'object' ? AUTH().roles : {};
  let changed = 0;
  if (j.roles && typeof j.roles === 'object') {
    for (const [u, rn] of Object.entries(j.roles)) {
      if (!(u in acc)) continue;
      if (rn === 'user') delete roles[u];
      else if (/^[\w一-龥.-]{1,32}$/.test(rn)) roles[u] = rn;
      else continue;
      changed++;
    }
  }
  if (changed) { AUTH().roles = roles; saveConfigRoles(roles); }
  log(`[ADMIN] ${clientIp(req)} 调整 ${changed} 个账号身份组`);
  return json(res, 200, { ok: true, changed });
}

function handleUpload(req, res) {
  if (!requireAuth(req)) return json(res, 401, { error: '未登录' });
  if (!checkToken(req)) return json(res, 403, { error: 'bad token' });
  if (!hasPerm(req, 'upload')) return json(res, 403, { error: '当前身份组无上传权限' });
  const name = sanitizeName(req.headers['x-file-name']);
  const max = (R.maxUploadMB || 2048) * 1024 * 1024;
  const len = parseInt(req.headers['content-length'] || '0', 10);
  const qs = quotaStateOf(req);
  if (qs.quota > 0) {
    const left = qs.quota * 1048576 - qs.up - qs.down;
    if (len > left) return json(res, 413, { error: '本月流量配额不足(剩 ' + Math.floor(left / 1048576) + 'MB)', quotaExceeded: true });
  }
  // 断点续传:同一文件键(x-upload-key)续传上次未完成的字节
  const key = String(req.headers['x-upload-key'] || '').replace(/[^0-9a-f]/gi, '').slice(0, 64);
  let offset = parseInt(req.headers['x-upload-offset'] || '0', 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const tmp = path.join(filesDir, tmpPrefix + (key || crypto.randomBytes(8).toString('hex')));
  let have = 0;
  if (key) { try { have = fs.statSync(tmp).size; } catch { have = 0; } }
  if (have !== offset) return json(res, 409, { error: 'offset-mismatch', offset: have });
  if (offset + len > max) return json(res, 413, { error: `文件超过 ${R.maxUploadMB}MB` });

  const out = fs.createWriteStream(tmp, offset ? { flags: 'a' } : { flags: 'w' });
  let bytes = 0, aborted = false; // bytes = 本次新增

  const fail = (code, msg, quota) => {
    if (aborted) return;
    aborted = true;
    req.unpipe(out); out.destroy();
    if (!key || quota) fs.unlink(tmp, () => {}); // 一次性上传直接清;有键的保留供续传;配额超限清残件
    if (!res.headersSent) json(res, code, quota ? { error: msg, quotaExceeded: true } : { error: msg });
    else res.destroy();
  };

  req.on('data', (c) => {
    bytes += c.length;
    if (offset + bytes > max) return fail(413, `文件超过 ${R.maxUploadMB}MB`);
    if (addTraffic(req, 'up', c.length) !== null) return fail(413, '本月流量配额已用完', true);
  });
  req.on('error', () => fail(400, '上传请求中断'));
  out.on('error', (e) => fail(500, '写盘失败: ' + e.message));
  out.on('finish', () => {
    if (aborted) return;
    const total = offset + bytes;
    if (total === 0) return fail(400, '空文件');
    const id = crypto.randomBytes(8).toString('hex');
    fs.rename(tmp, path.join(filesDir, id), (err) => {
      if (err) return fail(500, '落盘失败');
      meta.files[id] = { name, size: total, uploadedAt: Date.now(), by: clientIp(req) };
      saveMeta();
      log(`[RELAY][UP] ${clientIp(req)} 上传 ${name} (${(total / 1048576).toFixed(2)}MB${offset ? ',断点续传 +' + (bytes / 1048576).toFixed(2) + 'MB' : ''}) -> id=${id}`);
      json(res, 200, { ok: true, id, name, size: total });
    });
  });
  req.pipe(out);
}

function listFiles() {
  return Object.entries(meta.files)
    .map(([id, f]) => {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      return { id, name: f.name, size: f.size, uploadedAt: f.uploadedAt, by: f.by, pv: extPreviewName(id, f.name) };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function streamFile(req, res, id, inline) {
  const f = meta.files[id];
  if (!f) return json(res, 404, { error: '文件不存在或已删除' });
  if (!hasPerm(req, inline ? 'preview' : 'download')) return json(res, 403, { error: '当前身份组无此权限' });
  const fp = path.join(filesDir, id); // id 为服务端生成的十六进制,无路径穿越风险
  let st;
  try { st = fs.statSync(fp); } catch { delete meta.files[id]; saveMeta(); return json(res, 410, { error: '文件已丢失' }); }

  const total = st.size;
  const qs = quotaStateOf(req);
  if (qs.quota > 0) {
    const left = qs.quota * 1048576 - qs.up - qs.down;
    if (left <= 0) return json(res, 413, { error: '本月流量配额已用完', quotaExceeded: true });
    if (total > left) return json(res, 413, { error: '超出本月剩余配额(剩 ' + Math.floor(left / 1048576) + 'MB)', quotaExceeded: true });
  }
  const baseHeaders = {
    'content-type': inline ? mimeOf(f.name) : 'application/octet-stream',
    'content-disposition': disposition(f.name, inline),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'last-modified': st.mtime.toUTCString(),
  };

  // 单段 Range 支持(断点续传)
  const range = req.headers.range;
  let start = 0, end = total - 1, status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1); }
      else { start = Math.max(0, total - parseInt(m[2], 10)); } // 后缀范围
      if (start >= total || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        return res.end();
      }
      status = 206;
    }
  }
  const headers = { ...baseHeaders, 'content-length': end - start + 1 };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  // 下载流量入账(按本次实际发字节;非受限身份同样计数,便于管理页观察)
  const acc = { n: 0 };
  fs.createReadStream(fp, { start, end })
    .on('data', (c) => { acc.n += c.length; })
    .on('end', () => { if (acc.n) addTraffic(req, 'down', acc.n); })
    .on('error', () => res.destroy())
    .pipe(res);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('超过大小限制')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleNote(req, res) {
  if (!requireAuth(req)) return json(res, 401, { error: '未登录' });
  if (!checkToken(req)) return json(res, 403, { error: 'bad token' });
  if (req.method === 'GET') return json(res, 200, meta.note);
  if (req.method === 'PUT' || req.method === 'POST') {
    let buf;
    try { buf = await readBody(req, NOTE_MAX); }
    catch (e) { return json(res, 413, { error: e.message }); }
    meta.note = { text: buf.toString('utf8'), updatedAt: Date.now(), updatedBy: clientIp(req) };
    saveMeta();
    log(`[RELAY][NOTE] ${clientIp(req)} 更新了共享便签(${buf.length}B)`);
    return json(res, 200, { ok: true, ...meta.note });
  }
  json(res, 405, { error: 'method not allowed' });
}

function redirect(res, to, code) {
  res.writeHead(code || 302, { location: to, 'cache-control': 'no-store' });
  res.end();
}
function safeNext(n) {
  n = String(n || '');
  return n.startsWith('/') && !n.startsWith('//') ? n : '/relay';
}
function serveLoginPage(req, res) {
  fs.readFile(path.join(root, 'public', 'login.html'), (err, buf) => {
    if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('public/login.html 缺失'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(buf);
  });
}
function serveIndexPage(req, res) {
  if (!requireAuth(req)) return redirect(res, '/auth/login?next=' + encodeURIComponent(req.url || '/'));
  fs.readFile(path.join(root, 'public', 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('public/index.html 读取失败'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(buf);
  });
}
function serveAdminPage(req, res) {
  if (!requireAuth(req)) return redirect(res, '/auth/login?next=' + encodeURIComponent(req.url || '/admin'));
  if (!canAdmin(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('仅管理员可访问 /admin(本机直入即管理员)');
  }
  fs.readFile(path.join(root, 'public', 'admin.html'), (err, buf) => {
    if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('public/admin.html 读取失败'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(buf);
  });
}
async function handleLogin(req, res, mode) {
  let u = '', pw = '', next = '/relay';
  try {
    const buf = await readBody(req, 64 * 1024);
    const ct = String(req.headers['content-type'] || '');
    if (/json/i.test(ct)) {
      const j = JSON.parse(buf.toString('utf8') || '{}');
      u = String(j.user || j.username || ''); pw = String(j.password || j.pass || ''); next = j.next || next;
    } else {
      const q = new URLSearchParams(buf.toString('utf8'));
      u = q.get('user') || ''; pw = q.get('password') || ''; next = q.get('next') || next;
    }
  } catch {}
  const r = loginUser(u, pw);
  if (!r) {
    log(`[AUTH] 登录失败 user=${u} @${clientIp(req)}`);
    if (mode === 'form') return redirect(res, '/auth/login?e=1');
    return json(res, 401, { error: '账号或密码错误' });
  }
  log(`[AUTH] 登录成功 ${r.user}(${r.role}) @${clientIp(req)}`);
  res.setHeader('set-cookie', `relay_sid=${r.sid}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax`);
  if (mode === 'form') return redirect(res, safeNext(next));
  json(res, 200, { ok: true, user: r.user, role: r.role, next: safeNext(next) });
}
function handleLogout(req, res, mode) {
  const s = sessionOf(req);
  if (s) { delete sessions[s.sid]; saveSessions(); }
  res.setHeader('set-cookie', 'relay_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  if (mode === 'form') return redirect(res, '/');
  json(res, 200, { ok: true });
}

/* ---------- 局域网聊天室(零依赖 WebSocket / RFC6455) ---------- */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set(); // {socket,name,ip,buf,frag,lastPost,closed}
let chatLog = [];
const chatPath = path.join(root, 'storage', 'chat.json');

function loadChat() {
  try {
    const j = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
    if (Array.isArray(j)) chatLog = j.slice(-500);
  } catch {}
}
let chatSaveTimer = null;
function saveChat() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    try { fs.writeFileSync(chatPath, JSON.stringify(chatLog.slice(-500))); } catch {}
  }, 400);
}

function wsFrame(str, opcode) {
  const payload = Buffer.from(str || '', 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | (opcode || 1), len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | (opcode || 1); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | (opcode || 1); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function wsSend(cli, obj) {
  if (cli.closed) return;
  try { cli.socket.write(wsFrame(JSON.stringify(obj))); } catch {}
}
function broadcast(obj) { for (const c of clients) wsSend(c, obj); }
function presence() { broadcast({ type: 'presence', online: [...clients].map((c) => ({ name: c.name, ip: c.ip })) }); }
function pushMsg(msg) {
  chatLog.push(msg);
  if (chatLog.length > 500) chatLog.splice(0, chatLog.length - 500);
  saveChat();
  broadcast({ type: 'msg', msg });
}

function closeCli(cli) {
  if (cli.closed) return;
  cli.closed = true;
  clients.delete(cli);
  try { cli.socket.destroy(); } catch {}
  pushMsg({ sys: true, text: `${cli.name} 离开了聊天室`, ts: Date.now() });
  presence();
}

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  if (!requireAuth(req)) {
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const q = new URL(req.url, 'http://x').searchParams;
  let name = String(q.get('name') || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) || '朋友';
  if ([...clients].some((c) => c.name === name)) name += '-' + crypto.randomBytes(1).toString('hex');
  const sess = sessionOf(req);
  const cli = {
    socket, name, ip: clientIp(req), buf: Buffer.alloc(0), frag: [], lastPost: 0, closed: false,
    sid: sess ? sess.sid : null,
    isLocal: isAdmin(req) || checkTokenStrict(req),
  };
  clients.add(cli);
  wsSend(cli, { type: 'hello', name, online: [...clients].map((c) => ({ name: c.name, ip: c.ip })), hist: chatLog.slice(-100) });
  pushMsg({ sys: true, text: `${name} 加入了聊天室`, ts: Date.now() });
  presence();
  log(`[CHAT] ${cli.ip} "${name}" 进入聊天室 (在线 ${clients.size})`);

  socket.on('data', (d) => {
    cli.buf = Buffer.concat([cli.buf, d]);
    let b = cli.buf;
    while (b.length >= 2) {
      const b0 = b[0], b1 = b[1];
      const op = b0 & 0x0f;
      if (!(b1 & 0x80)) return closeCli(cli); // 浏览器帧必须带掩码
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > 64n * 1024n) return closeCli(cli); // 拒收巨型帧
        len = Number(big); off = 10;
      }
      if (b.length < off + 4 + len) break;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      b = b.subarray(off + 4 + len);
      cli.buf = b;
      if (op === 8) return closeCli(cli);
      if (op === 9) { try { socket.write(wsFrame(payload, 10)); } catch {} continue; } // ping→pong
      if (op === 10) continue;
      if (op === 0) { // 分片续帧
        cli.frag.push(payload);
        if (b0 & 0x80) handleCliText(Buffer.concat(cli.frag).toString('utf8'), cli);
        continue;
      }
      if (op === 1) {
        if (b0 & 0x80) handleCliText(payload.toString('utf8'), cli);
        else cli.frag = [payload];
      }
      // 其它 opcode(二进制=2)忽略
    }
  });
  socket.on('error', () => closeCli(cli));
  socket.on('close', () => closeCli(cli));
}

function handleCliText(raw, cli) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (!obj || obj.type !== 'msg' || typeof obj.text !== 'string') return;
  const now = Date.now();
  if (now - cli.lastPost < 250) return; // 限流
  cli.lastPost = now;
  const text = obj.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 2000);
  if (!text) return;
  if (!chatPerms(cli).includes('chat')) return; // 按当前角色实时判定(收权限即时生效)
  pushMsg({ from: cli.name, text, ts: now });
}

/* ---------- 网页转发浏览(/p/<url>) ---------- */
function browsePrefix(abs) { return '/p/' + encodeURIComponent(abs); }
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function rewriteCss(css, baseUrl) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, v) => {
    v = v.trim();
    if (!v || /^(#|data:|javascript:|blob:)/i.test(v)) return m;
    try {
      const abs = new URL(v, baseUrl).href;
      return /^https?:/i.test(abs) ? `url('${browsePrefix(abs)}')` : m;
    } catch { return m; }
  });
}

/* 改写浏览页。opts = { banner:boolean, home:Set|null(命中→door), door:string, inject:string(插到<head>后) } */
function rewriteBrowseHtml(html, baseUrl, opts) {
  opts = opts || {};
  let out = html.replace(/<base\b[^>]*>/i, ''); // 去掉原站 base 标签,避免干扰相对地址解析
  out = out.replace(/\b(href|src|action|poster)\s*=\s*(["'])([^"']*)\2/gi, (m, attr, q, val) => {
    const v = val.trim();
    if (!v || /^(#|javascript:|mailto:|tel:|data:|blob:|about:)/i.test(v) || v.startsWith('/p/')) return m;
    try {
      const abs = new URL(v, baseUrl);
      if (!/^https?:/i.test(abs.href)) return m;
      if (opts.home) { // 镜像模式:指向原站首页的链接(logo/首页导航)→ 换成暗门
        if (/^\/(index\.html?|home(\.html)?)?$/i.test(abs.pathname)) abs.pathname = '/';
        if (opts.home.has(abs.origin + '/')) return `${attr}=${q}${opts.door || '/relay'}${q}`;
      }
      return `${attr}=${q}${browsePrefix(abs.href)}${q}`;
    } catch { return m; }
  });
  out = out.replace(/<style[\s\S]*?<\/style>/gi, (blk) => blk.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, rewriteCss2(baseUrl)));
  function rewriteCss2(base) { return (m, q, v) => rewriteCss(m, base); }
  if (opts.inject) {
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + opts.inject);
    else out = opts.inject + out;
  }
  if (opts.banner === false) return out; // 镜像模式不加横幅
  // 中转浏览工具条:后退/刷新/回中继/地址栏(浏览器式中转)
  const cur = escHtml(baseUrl);
  const bs = 'font:13px sans-serif;padding:5px 10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;border-radius:7px;cursor:pointer;text-decoration:none;line-height:1.2;white-space:nowrap';
  const banner =
    '<div id="__relay_bar" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
    'background:#0f172aee;color:#e2e8f0;font:13px/1 sans-serif;padding:6px 10px;display:flex;gap:8px;align-items:center;border-bottom:2px solid #38bdf8">' +
    '<button style="' + bs + '" onclick="history.back()">← 后退</button>' +
    '<button style="' + bs + '" onclick="location.reload()">↻</button>' +
    '<a style="' + bs + '" href="/relay">🏠 中继站</a>' +
    '<input id="__rb_url" spellcheck="false" value="' + cur + '" style="flex:1;min-width:0;font:13px sans-serif;color:#e2e8f0;background:#0b1322;border:1px solid #334155;border-radius:7px;padding:6px 9px;outline:none">' +
    '<button id="__rb_go" style="' + bs + '">前往</button></div>' +
    '<script>(function(){var i=document.getElementById("__rb_url");function go(){var v=(i.value||"").trim();if(!v)return;' +
    'if(!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(v))v="http://"+v;location.href="/p/"+encodeURIComponent(v);}' +
    'document.getElementById("__rb_go").onclick=go;' +
    'i.onkeydown=function(e){if(e.key==="Enter")go();};})();<\/script>' +
    '<div style="height:3.2em"></div>';
  if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, (m) => m + banner);
  else out = banner + out;
  return out;
}

function browseErr(res, msg, from) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>转发失败</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;` +
    `color:#e2e8f0;font-family:"Microsoft YaHei",system-ui,sans-serif}.c{max-width:520px;padding:36px 44px;background:#1e293b;border-radius:14px;` +
    `border:1px solid #334155}h1{font-size:20px;color:#f87171;margin:0 0 10px}a{color:#38bdf8}</style></head><body><div class="c">` +
    `<h1>✖ 无法转发该页面</h1><p style="line-height:1.8;color:#94a3b8">${escHtml(msg)}</p>` +
    (from ? `<p>原地址:<code>${escHtml(from)}</code></p>` : '') +
    `<p><a href="/relay">← 返回中继站</a></p></div></body></html>`
  );
}

/* 转发子资源缓存(静态 css/js/img 短时内存缓存,提速+降低上游压力) */
const subCache = new Map(); // url -> {ts, body, type, code}
const SUB_TTL = 60 * 1000;
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cacheSub(url, code, type, body) {
  subCache.set(url, { ts: Date.now(), code, type, body });
  if (subCache.size > 400) { // 简单防膨胀
    const now = Date.now();
    for (const [k, v] of subCache) if (now - v.ts > SUB_TTL) subCache.delete(k);
  }
}

/* ---------- 文件预览(图片大图 / PDF / 文本 / EPUB 电子书) ---------- */
function previewable(ext) {
  return /^(png|jpe?g|gif|webp|bmp|svg|heic|pdf|txt|md|log|json|csv|html|htm)$/i.test(ext)
    || /^(epub|mobi|azw3)$/i.test(ext);
}

function extPreviewName(id, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const url = `/f/${id}?inline=1`;
  if (/^(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(ext)) return { kind: 'image', url };
  if (ext === 'pdf') return { kind: 'pdf', url };
  if (/^(txt|md|log|json|csv|html|htm)$/i.test(ext)) return { kind: 'text', url };
  if (/^(epub|mobi|azw3)$/i.test(ext)) return { kind: 'epub', url: `/api/preview/epub/${id}` };
  return null;
}

// EPUB(实为 zip):用内置 zlib 解 deflate 条目,提取正文纯文本,零第三方依赖
function extractEpubText(buf) {
  // 定位 EOCD,得中央目录
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06'));
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  let table = {};
  let pos = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compLen = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    table[name] = { method, compLen, localOff };
    pos += 46 + nameLen + extraLen + commLen;
  }
  function readFile(name) {
    const e = table[name];
    if (!e) return null;
    const lh = e.localOff;
    const lnameLen = buf.readUInt16LE(lh + 26);
    const lextraLen = buf.readUInt16LE(lh + 28);
    const start = lh + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + e.compLen);
    if (e.method === 0) return raw;                       // store
    try { return zlib.inflateRawSync(raw); } catch { return null; } // deflate
  }
  const container = readFile('META-INF/container.xml');
  if (!container) return null;
  const opfPath = (/full-path\s*=\s*["']([^"']+)/i.exec(container.toString('utf8')) || [])[1];
  if (!opfPath) return null;
  const opf = readFile(opfPath);
  if (!opf) return null;
  const opfTxt = opf.toString('utf8');
  const title = (/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opfTxt) || [])[1] || '';
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const spine = [];
  const idmap = {};
  let mt;
  const manifestRe = /<item\s+([^>]*)\/>/gi;
  while ((mt = manifestRe.exec(opfTxt))) {
    const attrs = mt[1];
    const id = (/id\s*=\s*["']([^"']+)/i.exec(attrs) || [])[1];
    const href = (/href\s*=\s*["']([^"']+)/i.exec(attrs) || [])[1];
    if (id && href) idmap[id] = href;
  }
  const spineRe = /<itemref\s+([^>]*)\/?>/gi;
  while ((mt = spineRe.exec(opfTxt))) {
    const idref = (/idref\s*=\s*["']([^"']+)/i.exec(mt[1]) || [])[1];
    if (idref && idmap[idref]) spine.push(idmap[idref]);
  }
  const chapters = [];
  for (const href of spine) {
    const content = readFile((baseDir + href).replace(/^(\.\/)+/, ''));
    if (!content) continue;
    let txt = content.toString('utf8');
    txt = txt.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (txt) chapters.push(txt);
  }
  if (!chapters.length) return null;
  return { title: title.replace(/<[^>]+>/g, '').trim() || '电子书', chapters };
}

async function handleBrowse(req, res, rawUrl, modeOpts) {
  const PR = R.proxy || {};
  const MIRROR = !!modeOpts; // 镜像模式:出错不露馅,静默回中继站
  // 网页中转权限:仅真实 /p/ 中转受 web 权限管;镜像门户(伪装门面)对匿名可见,登录在 /relay 才要求
  if (!MIRROR && !hasPerm(req, 'web')) return json(res, 403, { error: '当前身份组无网页中转权限' });
  if (PR.enabled === false) return MIRROR ? serveIndexPage(req, res) : browseErr(res, '转发浏览功能已关闭(config.relay.proxy.enabled=false)', '');
  let target;
  try { target = new URL(rawUrl); } catch { return MIRROR ? serveIndexPage(req, res) : browseErr(res, '网址不合法(请在地址栏输入 http:// 或 https:// 开头的完整地址)', rawUrl); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return browseErr(res, '只支持 http/https 协议', rawUrl);
  if (PR.blockPrivate && /(^10\.)|^127\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^localhost$/i.test(target.hostname))
    return browseErr(res, '该配置(blockPrivate)禁止访问内网地址', rawUrl);

  const method = req.method === 'POST' && /^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '') ? 'POST' : 'GET';
  let bodyBuf = null;
  if (method === 'POST') {
    try { bodyBuf = await readBody(req, 1024 * 1024); } catch { return browseErr(res, '表单数据过大', rawUrl); }
  }

  const fail = (msg, from) => (MIRROR ? serveIndexPage(req, res) : browseErr(res, msg, from));

  const doFetch = (u, depth) => {
    if (depth > 8) return fail('重定向次数过多', u.href);
    // 静态子资源短时缓存命中(省一趟上游,页面二次加载明显变快)
    const hit = subCache.get(u.href);
    if (hit && Date.now() - hit.ts < SUB_TTL && !MIRROR) {
      res.writeHead(hit.code, { 'content-type': hit.type, 'cache-control': 'no-store' });
      return res.end(hit.body);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'user-agent': modeOpts && modeOpts.ua ? modeOpts.ua : UA_CHROME,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'accept-encoding': 'identity',
      connection: 'close',
    };
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = bodyBuf.length;
    }
    const r = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: PR.timeoutMs || 15000, rejectUnauthorized: false },
      (up) => {
        if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
          let next;
          try { next = new URL(up.headers.location, u); } catch { return fail('重定向地址不合法', u.href); }
          up.resume();
          return doFetch(next, depth + 1);
        }
        const ct = (up.headers['content-type'] || '').toLowerCase();
        const chunks = [];
        let size = 0;
        const cap = (PR.maxSizeMB || 20) * 1048576;
        up.on('data', (c) => {
          size += c.length;
          if (size > cap) { up.destroy(); if (!res.headersSent) fail(`页面超过 ${PR.maxSizeMB || 20}MB 上限`, u.href); else res.destroy(); }
          chunks.push(c);
        });
        up.on('error', () => { if (!res.headersSent) fail('读取资源失败', u.href); else res.destroy(); });
        up.on('end', () => {
          const body = Buffer.concat(chunks);
          if (body.length) addTraffic(req, 'down', body.length); // 中转浏览流量入账(观察用,不设限)
          if (ct.includes('html')) {
            const html = rewriteBrowseHtml(decodePage(body, up.headers['content-type']), u.href, modeOpts);
            res.writeHead(up.statusCode || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(html);
          } else if (ct.includes('css')) {
            cacheSub(u.href, up.statusCode || 200, 'text/css; charset=utf-8', rewriteCss(body.toString('utf8'), u.href));
            res.writeHead(up.statusCode || 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
            res.end(body.toString('utf8'));
          } else if (/^(image\/|font\/|application\/font|audio\/|video\/)/.test(ct) && !MIRROR) {
            // 静态子资源:内存缓存提速,降低上游压力;镜像模式不做缓存(保持即时性)
            cacheSub(u.href, up.statusCode || 200, up.headers['content-type'] || 'application/octet-stream', body);
            const h = { 'cache-control': 'no-store' };
            if (up.headers['content-type']) h['content-type'] = up.headers['content-type'];
            res.writeHead(up.statusCode || 200, h);
            res.end(body);
          } else {
            const h = { 'cache-control': 'no-store' };
            if (up.headers['content-type']) h['content-type'] = up.headers['content-type'];
            res.writeHead(up.statusCode || 200, h);
            res.end(body);
          }
        });
      }
    );
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', (e) => fail(`抓取失败: ${e.message}`, u.href));
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  };
  doFetch(target, 0);
}

// 页面编码处理:声明了 GBK/GB2312/Big5 的老页面转 UTF-8
function decodePage(buf, contentType) {
  const head = buf.subarray(0, 2048).toString('latin1');
  const charset = (/charset=["']?([\w-]+)/i.exec(contentType || '') || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || '';
  if (/^(gbk|gb2312|gb18030|big5)$/i.test(charset)) {
    try { return new TextDecoder(charset.toLowerCase()).decode(buf); } catch {}
  }
  return buf.toString('utf8');
}

/* ---------- 伪装门户(镜像原站 + logo 暗门) ---------- */
function mirrorOpts() {
  const M = R.mirror || {};
  if (!M.enabled || !M.url) return null;
  let u;
  try { u = new URL(M.url); } catch { return null; }
  const door = M.door || '/relay';
  return {
    banner: false,
    home: new Set([u.origin + '/']),
    door,
    ua: M.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // 给页面注入两样东西:
    //  1) fetch/XHR 补丁:原站数据接口走 /p/ 代理,绕开跨域
    //  2) 运行时暗门:SPA 渲染出顶部 logo 后,点击 logo → door(/relay)进中继站后台
    inject:
      '<script>(function(){var B=' + JSON.stringify(u.origin) + ';function rw(x){try{if(typeof x!=="string")return x;' +
      'if(x.indexOf(B)===0)return"/p/"+encodeURIComponent(x);if(x.charAt(0)==="/")return"/p/"+encodeURIComponent(B+x);' +
      'return x}var of=window.fetch;if(of)window.fetch=function(i,o){if(typeof i==="string")i=rw(i);return of.call(this,i,o)};' +
      'var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=[].slice.call(arguments);' +
      'if(typeof a[1]==="string")a[1]=rw(a[1]);return oo.apply(this,a)};' +
      'var DOOR=' + JSON.stringify(door) + ';function isLogo(a){var im=a&&a.querySelector?a.querySelector("img"):null;' +
      'if(im){var s=(im.getAttribute("src")||im.src||"");if(/logo|comlogo|icon/i.test(s))return true;}' +
      'var h=(a.getAttribute("href")||"").toLowerCase();if(!/^(\\/|\\/index\\.html?|\\/home)$/.test(h))return false;' +
      'var cls=((a.className||"")+" "+(a.parentElement?a.parentElement.className:"")).toLowerCase();' +
      'return /(^|[\\s_-])(logo|home|header)[\\s_-]/.test(cls);}' +
      'document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a"):null;' +
      'if(!a)return;if(isLogo(a)){e.preventDefault();e.stopPropagation();location.href=DOOR;}},true);' +
      // 极简暗门角标:右上角半透明「进入」,平时不显眼,悬停变清晰
      'function mkDoor(){try{var b=document.createElement("a");b.href=DOOR;b.textContent="进入";' +
      'b.style.cssText="position:fixed;top:5px;right:8px;z-index:2147483647;font:12px/2 sans-serif;color:#fff;' +
      'background:rgba(0,0,0,.25);border-radius:10px;padding:1px 10px;text-decoration:none;opacity:.5;transition:opacity .2s";' +
      'b.onmouseenter=function(){b.style.opacity=1};b.onmouseleave=function(){b.style.opacity=.5};' +
      '(document.body||document.documentElement).appendChild(b);}catch(e){}}' +
      'if(document.body)mkDoor();else document.addEventListener("DOMContentLoaded",mkDoor);})();</script>',
  };
}

/* ---------- 路由 ---------- */

const router = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    const mo = mirrorOpts();
    if ((p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (mo) return handleBrowse(req, res, R.mirror.url, mo); // 伪装门户:实时镜像原站
      return serveIndexPage(req, res);
    }
    if ((p === (mo && mo.door) || p === '/relay' || p === '/station') && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveIndexPage(req, res); // 真身:中继站后台
    }
    // 设备联网检测响应(Android/MIUI/EMUI/vivo/Windows NCSI):
    // 这些域名被 DNS 劫持到本机后,浏览器/系统在此拿到期望响应 → 显示"已连接"
    if (p === '/generate_204' || p === '/gen_204') { res.writeHead(204); return res.end(); }
    if (p === '/connecttest.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Microsoft Connect Test'); }
    if (p === '/ncsi.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Microsoft NCSI'); }
    if (p === '/api/info') {
      const s = sessionOf(req);
      return json(res, 200, {
        maxUploadMB: R.maxUploadMB, fileCount: Object.keys(meta.files).length, noteMax: NOTE_MAX,
        admin: canAdmin(req),
        auth: { enabled: !!AUTH().enabled, user: s ? s.user : null, role: s ? roleOf(s.user) : (isAdmin(req) ? 'admin' : null) },
        perms: permsOfReq(req),
        usage: quotaStateOf(req), // {quota, up, down} 本月(月变自动归零);quota=0 不限
      });
    }
    // —— 管理接口(身份组/权限范围/流量) ——
    if (p === '/admin' && (req.method === 'GET' || req.method === 'HEAD')) return serveAdminPage(req, res);
    if (p === '/api/admin/roles' && req.method === 'GET') {
      if (!canAdmin(req)) return json(res, 403, { error: '仅管理员' });
      return json(res, 200, {
        perms: PERMS, defaultPerms: rolesCfg.defaultPerms, roles: rolesCfg.roles,
        accounts: Object.keys(authAccounts()),
      });
    }
    if (p === '/api/admin/roles' && req.method === 'POST') return handleRolesPost(req, res);
    if (p === '/api/admin/accounts' && req.method === 'GET') {
      if (!canAdmin(req)) return json(res, 403, { error: '仅管理员' });
      const acc = authAccounts();
      return json(res, 200, {
        accounts: Object.keys(acc).map((u) => ({ user: u, role: roleOf(u), quotaMB: quotaOfRole(roleOf(u)) })),
        roles: Object.keys(rolesCfg.roles).concat(['user', 'admin']),
      });
    }
    if (p === '/api/admin/accounts' && req.method === 'POST') return handleAccountsPost(req, res);
    if (p === '/api/admin/traffic' && req.method === 'GET') {
      if (!canAdmin(req)) return json(res, 403, { error: '仅管理员' });
      pruneTraffic();
      const rows = Object.entries(traffic).map(([u, t]) => ({
        user: u, up: t.up || 0, down: t.down || 0, y: t.y, m: t.m,
        quota: u.startsWith('__') ? 0 : quotaOfRole(roleOf(u)),
      })).sort((a, b) => (b.up + b.down) - (a.up + a.down));
      return json(res, 200, { month: new Date().toISOString().slice(0, 7), rows });
    }
    if (p === '/api/admin/traffic/reset' && req.method === 'POST') return handleTrafficReset(req, res);
    // —— 登录/登出(账号鉴权) ——
    if (p === '/auth/login' && req.method === 'GET') {
      if (requireAuth(req)) return redirect(res, safeNext(url.searchParams.get('next')));
      return serveLoginPage(req, res);
    }
    if (p === '/auth/login' && req.method === 'POST') return handleLogin(req, res, 'form');
    if (p === '/auth/logout' && req.method === 'GET') return handleLogout(req, res, 'form');
    if (p === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res, 'json');
    if (p === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res, 'json');
    if (p === '/api/upload/status' && req.method === 'GET') {
      if (!requireAuth(req)) return json(res, 401, { error: '未登录' });
      const k = String(url.searchParams.get('key') || '').replace(/[^0-9a-f]/gi, '').slice(0, 64);
      let off = 0;
      if (k) { try { off = fs.statSync(path.join(filesDir, tmpPrefix + k)).size; } catch {} }
      return json(res, 200, { offset: off });
    }
    if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res);
    if (p === '/api/files' && req.method === 'GET') {
      if (!requireAuth(req)) return json(res, 401, { error: '未登录' });
      return json(res, 200, listFiles());
    }
    if (p === '/api/note') return handleNote(req, res);
    if (p === '/p/' || p.startsWith('/p/')) {
      if (!requireAuth(req)) return redirect(res, '/auth/login?next=' + encodeURIComponent(req.url));
      let decoded;
      try { decoded = decodeURIComponent(p.slice(3)); } catch { decoded = p.slice(3); }
      if (url.search && !decoded.includes('?')) decoded += url.search; // 手打未编码场景
      if (!/^https?:\/\//i.test(decoded)) decoded = 'http://' + decoded;
      if (req.method === 'GET' || req.method === 'POST') return handleBrowse(req, res, decoded);
      return json(res, 405, { error: 'method not allowed' });
    }
    if (p === '/api/chat/clear' && req.method === 'POST') {
      if (!canAdmin(req)) return json(res, 403, { error: '仅管理员可清空聊天(本机访问即管理员)' });
      if (AUTH().enabled && !hasPerm(req, 'admin')) return json(res, 403, { error: '当前身份组无管理权限' });
      chatLog = [];
      saveChat();
      broadcast({ type: 'clear' });
      log(`[CHAT] ${clientIp(req)} 清空了聊天记录`);
      return json(res, 200, { ok: true });
    }
    // 电子书(epub/mobi/azw3)预览:内置 zip 解压 + 提取正文纯文本
    let em = /^\/api\/preview\/epub\/([0-9a-f]{16})$/.exec(p);
    if (em && req.method === 'GET') {
      if (!requireAuth(req)) return json(res, 401, { error: '未登录' });
      if (!hasPerm(req, 'preview')) return json(res, 403, { error: '当前身份组无预览权限' });
      const f = meta.files[em[1]];
      if (!f) return json(res, 404, { error: '不存在' });
      const fp = path.join(filesDir, em[1]);
      let buf;
      try { buf = fs.readFileSync(fp); } catch { return json(res, 410, { error: '文件已丢失' }); }
      const book = extractEpubText(buf);
      if (!book) return json(res, 415, { error: '无法解析的电子书(可能已加密/损坏/非标准EPUB)' });
      const ch = (url.searchParams.get('c') || 1) - 1;
      const ci = Math.max(0, Math.min(book.chapters.length - 1, ch));
      const text = book.chapters[ci];
      const nav = book.chapters.map((_, i) => `<a href="/api/preview/epub/${em[1]}?c=${i + 1}"${i === ci ? ' class="on"' : ''}>${i + 1}</a>`).join('');
      const htm =
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escHtml(book.title)} · 电子书预览</title>` +
        `<style>:root{--paper:#f5f4f0;--ink:#12100d;--ink2:#6b665c;--red:#d94f2b;--line:#e2e0da}` +
        `*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.85 "Georgia","Noto Serif SC","Songti SC",serif;-webkit-font-smoothing:antialiased}` +
        `.top{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:12px 20px;display:flex;align-items:center;gap:14px;z-index:5}` +
        `.top b{font:700 14px/1 sans-serif}.top .ttl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2);font:12px/1 sans-serif}` +
        `.top a{color:#fff;background:var(--red);text-decoration:none;font:12px/1 sans-serif;padding:6px 12px}` +
        `.nav{position:sticky;top:49px;background:#fff;border-bottom:1px solid var(--line);padding:8px 14px;display:flex;flex-wrap:wrap;gap:6px;z-index:4}` +
        `.nav a{font:12px/1 ui-monospace,Consolas,monospace;color:var(--ink2);text-decoration:none;border:1px solid var(--line);padding:3px 7px}` +
        `.nav a.on{background:var(--red);color:#fff;border-color:var(--red)}` +
        `.page{max-width:720px;margin:0 auto;padding:36px 24px 90px;white-space:pre-wrap;word-wrap:break-word}` +
        `.bar{padding:14px 16px;text-align:center;font:11px/1 sans-serif;color:var(--ink2)}` +
        `.bar a{color:var(--red)}@media(max-width:520px){.top{padding:10px 12px}.page{padding:22px 14px 70px}}</style></head><body>` +
        `<div class="top"><b>书</b><span class="ttl">${escHtml(book.title)}</span><a href="/f/${em[1]}" download>下载</a></div>` +
        `<div class="nav">${nav}</div>` +
        `<div class="page">${escHtml(text)}</div>` +
        `<div class="bar">章节 ${ci + 1} / ${book.chapters.length} · <a href="/api/preview/epub/${em[1]}?c=${Math.min(ci + 2, book.chapters.length)}">下一章</a></div>` +
        `</body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(htm);
    }
    let m = /^\/f\/([0-9a-f]{16})$/.exec(p);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!requireAuth(req)) return redirect(res, '/auth/login?next=' + encodeURIComponent(req.url));
      return streamFile(req, res, m[1], url.searchParams.get('inline') === '1');
    }
    m = /^\/api\/files\/([0-9a-f]{16})$/.exec(p);
    if (m && req.method === 'DELETE') {
      if (!canAdmin(req)) return json(res, 403, { error: '仅管理员可删除文件(本机访问即管理员)' });
      if (AUTH().enabled && !hasPerm(req, 'delete')) return json(res, 403, { error: '当前身份组无删除权限' });
      const id = m[1];
      if (!meta.files[id]) return json(res, 404, { error: '不存在' });
      log(`[RELAY][DEL] ${clientIp(req)} 删除 ${meta.files[id].name} (id=${id})`);
      delete meta.files[id];
      fs.unlink(path.join(filesDir, id), () => {});
      saveMeta();
      return json(res, 200, { ok: true });
    }
    // 镜像模式兜底:其它 GET 路径(product/x、favicon.ico…)→ 原站深链,保持"和原版一样"
    if (mo && R.mirror.catchAll !== false && req.method === 'GET') {
      try {
        const t = new URL(p + url.search, R.mirror.url);
        if (t.origin === new URL(R.mirror.url).origin) return handleBrowse(req, res, t.href, mo);
      } catch {}
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log(`[RELAY][ERR] ${e.stack || e}`);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  }
};

function start(config, logger) {
  log = logger || log;
  R = Object.assign({ enabled: true, host: '127.0.0.1', port: 28791, maxUploadMB: 2048 }, config.relay || {});
  if (!R.enabled) return Promise.resolve(null);
  ensureDirs();
  loadMeta();
  loadChat();
  loadSessions();
  loadRoles();
  loadTraffic();
  const srv = http.createServer(router);
  srv.requestTimeout = 0; // 大文件上传不设总时长限制(空闲由客户端决定)
  srv.headersTimeout = 60000;

  // 聊天 WebSocket(/ws/chat)
  srv.on('upgrade', (req, socket) => {
    let p = '/';
    try { p = new URL(req.url, 'http://x').pathname; } catch {}
    if (p === '/ws/chat') return wsAccept(req, socket);
    socket.destroy();
  });
  // 25 秒服务端 ping,穿过反代保持连接(浏览器自动回 pong)
  setInterval(() => {
    for (const c of clients) { try { c.socket.write(wsFrame('', 9)); } catch { closeCli(c); } }
  }, 25000).unref();

  // 端口被占(如 wslrelay.exe 抢占动态端口)时自动 +1 避让,最多试 10 个
  const tryListen = (port, attempt) => {
    srv.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempt < 10) {
        log(`[RELAY] 端口 ${port} 被占用,避让到 ${port + 1}`);
        tryListen(port + 1, attempt + 1);
      } else {
        log(`[RELAY] 启动失败: ${e.message}`);
        resolvePort(null);
      }
    });
    srv.listen(port, R.host, () => {
      R.port = port;
      log(`[RELAY] 中继站已启动 http://${R.host}:${port} (存储 ${path.relative(root, filesDir)}/,上限 ${R.maxUploadMB}MB/文件)`);
      resolvePort(port);
    });
  };
  let resolvePort;
  const p = new Promise((r) => { resolvePort = r; });
  tryListen(R.port, 0);
  return p;
}

module.exports = { start };
