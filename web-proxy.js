'use strict';
/**
 * 拦截站点 Web 服务器
 * - 监听 :80 / :443(自签 PFX 证书),把所有请求反向代理到 config.target
 * - target 未配置或不可达时,返回占位提示页(证明链路已通)
 * - 支持 WebSocket / Vite HMR 升级透传,重写 Location 头
 */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

let cfg = null;
let log = () => {};
let target = null; // new URL(cfg.target) 或 null

/* ---------- 占位提示页 ---------- */
function fallbackHtml(reason) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>拦截已生效 · ${cfg && cfg.sinkholeDomain}</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f172a;color:#e2e8f0;font-family:"Microsoft YaHei",system-ui,sans-serif}
 .card{max-width:560px;padding:40px 48px;background:#1e293b;border-radius:16px;
       border:1px solid #334155;box-shadow:0 20px 60px rgba(0,0,0,.5)}
 h1{margin:0 0 12px;font-size:22px;color:#38bdf8}
 code{background:#0f172a;padding:2px 8px;border-radius:6px;color:#a5f3fc}
 p{line-height:1.8;font-size:15px;color:#94a3b8}
 .ok{color:#4ade80}.warn{color:#fbbf24}
</style></head><body><div class="card">
 <h1>✔ DNS Sinkhole 拦截已生效</h1>
 <p>你对 <code>${(cfg && cfg.sinkholeDomain) || '?'}</code> 的访问已被局域网拦截并导向本机。</p>
 <p class="warn">目标站点尚未接入:${reason || 'config.target 为空'}。</p>
 <p>在 <code>config.json</code> 的 <code>target</code> 填入你的本地站点地址(如 <code>http://127.0.0.1:3003</code>)并重启本服务即可展示网站内容。</p>
</div></body></html>`;
}

/* ---------- Location 重写 ---------- */
function rewriteLocation(loc, req) {
  try {
    if (!target) return loc;
    const abs = new URL(loc, target.href);
    if (abs.origin === target.origin) {
      const proto = req.socket.__sinkholeTls ? 'https' : 'http';
      return proto + '://' + (req.headers.host || cfg.answerIP) + abs.pathname + abs.search + abs.hash;
    }
    return loc;
  } catch {
    return loc;
  }
}

/* ---------- 反向代理核心 ---------- */
function proxyRequest(req, res) {
  if (!target) {
    log(`[WEB] 未配置 target,返回占位页 ${req.headers.host}${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fallbackHtml('config.json 里 target 为空'));
  }
  const tIsHttps = target.protocol === 'https:';
  const tMod = tIsHttps ? https : http;
  const headers = { ...req.headers, host: target.host };
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-for'] = (headers['x-forwarded-for'] ? headers['x-forwarded-for'] + ', ' : '') + (req.socket.remoteAddress || '');
  headers['x-forwarded-proto'] = req.socket.__sinkholeTls ? 'https' : 'http';

  const up = tMod.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (tIsHttps ? 443 : 80),
      path: req.url.startsWith('/') ? req.url : '/' + req.url,
      method: req.method,
      headers,
      timeout: 30000,
      rejectUnauthorized: false,
    },
    (upRes) => {
      const h = { ...upRes.headers };
      if (h.location) h.location = rewriteLocation(h.location, req);
      res.writeHead(upRes.statusCode, upRes.statusMessage || '', h);
      upRes.pipe(res);
    }
  );
  up.on('timeout', () => up.destroy(new Error('上游站点超时')));
  up.on('error', (err) => {
    log(`[WEB] 代理失败 ${req.url} -> ${cfg.target}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fallbackHtml(`目标站点不可达(${err.message})`));
    } else res.destroy();
  });
  req.pipe(up);
}

/* ---------- WebSocket 升级透传 ---------- */
function attachUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    if (!target) return socket.destroy();
    const tIsHttps = target.protocol === 'https:';
    const port = target.port || (tIsHttps ? 443 : 80);
    const up = tIsHttps
      ? tls.connect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: false })
      : net.connect(port, target.hostname);
    const onReady = () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const hdrs = { ...req.headers, host: target.host };
      const ip = req.socket.remoteAddress || '';
      hdrs['x-forwarded-for'] = (hdrs['x-forwarded-for'] ? hdrs['x-forwarded-for'] + ', ' : '') + ip;
      for (const [k, v] of Object.entries(hdrs)) lines.push(`${k}: ${v}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    };
    up.once(tIsHttps ? 'secureConnect' : 'connect', onReady);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
}

/* ---------- 启动 ---------- */
function start(config, logger) {
  cfg = config;
  log = logger || log;

  if (cfg.target) {
    try {
      target = new URL(cfg.target);
    } catch {
      log(`[WEB] target 不是合法 URL,忽略: ${cfg.target}`);
    }
  }

  const srv = http.createServer(proxyRequest);
  srv.requestTimeout = 0;      // 大文件上传/下载不设总时长上限
  srv.keepAliveTimeout = 65000;
  attachUpgrade(srv);
  srv.listen(cfg.httpPort, '0.0.0.0', () =>
    log(`[WEB] HTTP :${cfg.httpPort} 已监听 -> ${cfg.target || '(占位页)'}`)
  );
  srv.on('error', (e) => log(`[WEB] HTTP 错误: ${e.message}`));

  const pfxPath = path.join(__dirname, cfg.cert.pfx);
  if (fs.existsSync(pfxPath)) {
    const pfx = fs.readFileSync(pfxPath);
    const tlsOpts = { pfx, passphrase: cfg.cert.passphrase };
    if (!tlsOpts.passphrase) delete tlsOpts.passphrase;
    const s = https.createServer(tlsOpts, proxyRequest);
    s.requestTimeout = 0;
    s.keepAliveTimeout = 65000;
    s.on('connection', (sock) => { sock.__sinkholeTls = true; });
    attachUpgrade(s);
    s.listen(cfg.httpsPort, '0.0.0.0', () =>
      log(`[WEB] HTTPS :${cfg.httpsPort} 已监听 (自签证书 ${cfg.cert.pfx})`)
    );
    s.on('tlsClientError', (e) => log(`[WEB] TLS 握手失败(客户端未信任证书?): ${e.message}`));
    s.on('error', (e) => log(`[WEB] HTTPS 错误: ${e.message}`));
  } else {
    log(`[WEB] 未找到证书 ${pfxPath},HTTPS 未启动。请先运行 make-cert.ps1`);
  }
}

module.exports = { start };
