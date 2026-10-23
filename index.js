'use strict';
/**
 * 拦截域名局域网 DNS Sinkhole 入口(拦截哪个域名见 config.json)
 * 单进程同时启动:DNS 拦截服务器(:53) + 站点代理(:80/:443)
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
/* 配置装载带兜底:config.json 损坏(写一半断电/手工编辑坏)→ 自动回退 .bak 备份
   (管理器写配置前会自动留 .bak);都坏才崩,且日志写明,不再"无输出神秘退出" */
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); }
  catch (e) {
    const msg = `config.json 解析失败: ${e.message}`;
    try { fs.appendFileSync(path.join(root, 'logs', 'sinkhole.log'), `[FATAL] ${new Date().toISOString()} ${msg}\n`); } catch {}
    try {
      const bak = JSON.parse(fs.readFileSync(path.join(root, 'config.json.bak'), 'utf8'));
      try { fs.appendFileSync(path.join(root, 'logs', 'sinkhole.log'), `[WARN] 已回退 config.json.bak\n`); } catch {}
      return bak;
    } catch { throw new Error(`${msg}；且 config.json.bak 也不可用/不存在`); }
  }
}
const cfg = loadCfg();

const logsDir = path.join(root, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'sinkhole.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    // 轮转：>8MB 时 sinkhole.log → sinkhole.log.1（旧 .1 覆盖）——防 2.8MB→无限涨
    try { const st = fs.statSync(logFile); if (st.size > 8 * 1048576) fs.renameSync(logFile, logFile + '.1'); } catch {}
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
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
