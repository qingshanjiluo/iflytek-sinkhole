'use strict';
// 聊天室双客户端自测:默认走 :80 反代完整链路  node test-chat.js [ws-url]
const base = process.argv[2] || 'ws://127.0.0.1/ws/chat';
function cli(name) {
  const s = new WebSocket(base + '?name=' + encodeURIComponent(name));
  s.messages = [];
  s.onmessage = (e) => { try { s.messages.push(JSON.parse(e.data)); } catch {} };
  return s;
}
const a = cli('测试甲');
const b = cli('测试乙');
let sent = false;
a.onopen = () => setTimeout(() => {
  if (sent) return; sent = true;
  a.send(JSON.stringify({ type: 'msg', text: '你好,我是甲 🍎' }));
}, 800);
setTimeout(() => {
  const bMsgs = b.messages.filter((m) => m.type === 'msg');
  const types = a.messages.map((m) => m.type).join(',');
  const presence = b.messages.filter((m) => m.type === 'presence').pop();
  const hello = a.messages.find((m) => m.type === 'hello');
  console.log('甲收到事件序列 :', types || '(无)');
  console.log('乙收到聊天消息 :', bMsgs.length ? JSON.stringify(bMsgs[0].msg) : '(无)');
  console.log('在线名单       :', presence ? presence.online.map((o) => o.name).join(' / ') : '(无)');
  console.log('历史消息字段   :', hello && Array.isArray(hello.hist) ? 'hist×' + hello.hist.length : '(缺)');
  const pass = bMsgs.some((m) => m.msg.text.includes('我是甲'));
  console.log(pass ? '✅ PASS' : '❌ FAIL');
  try { a.close(); b.close(); } catch {}
  process.exit(pass ? 0 : 1);
}, 3500);
