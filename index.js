'use strict';
/**
 * 拦截域名局域网 DNS Sinkhole 入口(拦截哪个域名见 config.json)
 * 单进程同时启动:DNS 拦截服务器(:53) + 站点代理(:80/:443)
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

const logsDir = path.join(root, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'sinkhole.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

log('===== sinkhole 服务启动 =====');
if (process.argv.includes('--dns-only')) {
  require('./dns-server').start(cfg, log);
} else {
  const relay = require('./relay-site');
  Promise.resolve(relay.start(cfg, log)).then((port) => {
    if (port) cfg.target = `http://127.0.0.1:${port}`; // 实际端口跟随(避让被占端口)
    require('./web-proxy').start(cfg, log);
    require('./dns-server').start(cfg, log);
    require('./dhcp-server').start(cfg, log); // 内置 DHCP:替代坏死的 ICS,给连热点的设备发 137.x IP
    log('运行中。Ctrl+C 或运行 stop.ps1 停止。');
  });
}

process.on('uncaughtException', (e) => log(`[FATAL] ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`[FATAL-REJECT] ${e}`));
