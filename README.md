# iflytek.com 局域网 DNS Sinkhole · 三合一中继站

局域网内任何设备访问 **iflytek.com** → DNS 被解析到本机 → 打开的是你自己搭的
**局域网中继站**,自带三大功能:

| 功能 | 说明 |
|---|---|
| 📦 文件互传 | 拖拽**文件夹**上传(递归)、**断点续传**、**下载进度条**、**下载可指定本地文件夹**(File System Access);图片**大图灯箱**、PDF/文本**内嵌预览**、**EPUB 电子书章节阅读**;单文件 ≤2GB |
| 💬 局域网聊天 | WebSocket 实时聊天室,在线名单+历史记录(重启不丢) |
| 🌐 网页转发 | 浏览器式中转(后退/刷新/地址栏);**Chrome UA 伪装+sec-fetch 头**降拦截、静态资源**内存缓存提速**、重定向 8 跳;输入任意网址(含内网页 `192.168.1.1`)逐页点入 |
| 🔐 登录鉴权 | 账号密码登录(cookie 会话 30 天),`sifangzhiji` 为管理员=删文件/清聊天,其它账号=普通用户;本机免登录直入 |
| 🎭 伪装门户 | 访问拦截域名先看到**实时镜像的原版官网**(`relay.mirror`),**点顶部 logo 进暗门** `/relay` 才是中继站后台 |

外加:📝 跨设备文字便签。零第三方依赖(纯 Node 内置模块),含便携运行时,
**整个文件夹拷到任何 Windows 电脑一条命令部署**。

> ⚠️ 仅在你自己管理、有权配置的网络中使用。`iflytek.com` 是讯飞真实域名:
> - 默认**只拦精确域名**(`blockSubdomains: false`),`www./aiui.` 等子域不受影响;
> - 真实域名可能带 **HSTS**:访问过真站的设备需安装 `certs/iflytek.cer` 才不报错;
> - 聊天/文件/便签对局域网所有设备可见,属"信任网络"设计,勿放敏感资料;
> - 网页转发等于给局域网开了一台代理(可访问外网/内网页面),不想用可关
>   `relay.proxy.enabled=false`。

## 换电脑快速部署(插谁谁开)

```powershell
# 1. 整个 iflytek-sinkhole 文件夹拷到新电脑任意位置(内含 runtime\node.exe,免装 Node)
# 2. 管理员 PowerShell:
Set-Location <你的路径>\iflytek-sinkhole
.\setup-on-this-pc.ps1        # 证书+防火墙+开机自启+启动,一条命令
# 3. 新电脑开热点:设置→移动热点(共享"以太网"或它的上网方式)
#    或把路由器/光猫 DHCP 下发的 DNS 指向本机 IP
# 4. 设备浏览器访问 http://iflytek.com
```

- **DNS 应答全自动**:查询来自哪个网段,就回本机在那个网段的 IP(内网回内网卡、
  移动热点客户端回 `192.168.137.1`),换网络/换电脑不用改配置
- **白名单自动**:默认放行本机所有网卡网段(防公网滥用的意图保留,IPv6 直连拒绝)
- 网卡插拔、热点开关后 15 秒内自动感知并重新抢占 53 端口(与 ICS 共存问题自愈)
- 卸载:`.\uninstall-on-this-pc.ps1`(任务/防火墙删干净,存储文件保留)
- 系统没装 Node 也不想用自带运行时:`.\setup-on-this-pc.ps1 -BundleRuntime`
  (从 npmmirror 下载便携版 Node 到 `runtime\`)

## 组成

| 文件 | 作用 |
|---|---|
| `index.js` | 入口:中继站 → Web 代理 → DNS 依序启动,日志 `logs/sinkhole.log` |
| `dns-server.js` | 零依赖 DNS:拦截应答(网段自适应)+其余转发上游,UDP/TCP :53 |
| `dhcp-server.js` | 零依赖 DHCP(:67):**替代坏死的 ICS**,给连热点的设备发 `192.168.137.x`,MAC 哈希稳定分配 |
| `web-proxy.js` | :80/:443 反代到中继站,自签 HTTPS,WebSocket 透传,大文件不限时长 |
| `relay-site.js` | 中继站:文件 API + 聊天室(手写 RFC6455)+ 网页转发 `/p/` + 便签 + 登录鉴权/会话 |
| `public/index.html` | 前端:上传(断点续传)/文件列表/聊天室/网页转发/便签,手机自适应 |
| `public/login.html` | 登录页(账号密码表单) |
| `storage/` | `files/`+`meta.json` 文件;`chat.json` 聊天记录;`sessions.json` 登录会话 |
| `runtime/node.exe` | 便携 Node 运行时(v24 x64),换机免装 |
| `make-cert.ps1` / `setup-firewall.ps1` / `register-autostart.ps1` | 单项脚本 |
| `setup-on-this-pc.ps1` / `uninstall-on-this-pc.ps1` | **一键装机/卸载** |
| `start.ps1` / `stop.ps1` | 手动后台启停(按 `--svc-sinkhole` 标记识别进程) |
| `test-chat.js` | 聊天室双客户端自测 |
| `test-dhcp.js` | DHCP 全流程自测(本机模拟手机 DISCOVER→OFFER→REQUEST→ACK) |

## API 一览

```
GET    /                  门户(镜像开启=实时镜像原官网;关闭=中继站页面)
/relay                    中继站后台(门户上点 logo 进入;mirror.door 可改)
POST   /api/upload        头 x-file-name=<encodeURIComponent(名字)>,body=原始字节
GET    /api/files         文件列表
GET    /f/<id>            下载(单段 Range 续传;?inline=1 预览)
DELETE /api/files/<id>    删除
GET/PUT /api/note         共享文字便签(≤1MB)
WS     /ws/chat?name=昵称  聊天室(hello含历史/msg/presence;历史500条持久化)
POST   /api/chat/clear    清空聊天
GET/POST /p/<urlencode(URL)>  网页转发浏览(HTML改写链接/CSS url()/重定向跟踪/GBK转码)
GET/POST /auth/login       登录(表单 POST→302;`?next=` 回跳,`?e=1` 密码错)
GET     /auth/logout       登出(清 cookie 回 `/`)
POST    /api/auth/login    登录(JSON:{user,password,role} → {ok,user,role})
POST    /api/auth/logout    登出(JSON)
GET     /api/upload/status?key=xx  上传断点查询(返回 {offset})
POST   /api/upload         上传;头 x-file-name + x-upload-key + x-upload-offset(断点续传,offset 起追加)
GET    /api/files          文件列表
GET    /f/<id>             下载(单段 Range 续传;?inline=1 预览)
DELETE /api/files/<id>     删除(管理员)
GET/PUT /api/note          共享文字便签(≤1MB)
WS     /ws/chat?name=昵称   聊天室(hello含历史/msg/presence;历史500条持久化)
POST   /api/chat/clear     清空聊天(管理员)
GET/POST /p/<urlencode(URL)>  网页转发浏览(HTML改写链接/CSS url()/重定向跟踪/GBK转码/工具条/UA伪装/子资源缓存)
GET    /api/preview/epub/<id>?c=1  EPUB 电子书预览(内置 zip 解压提取正文,章节导航)
GET    /api/info           站点信息(含 admin/auth 登录状态);/api/files 每项含 pv 预览元数据
```

## 配置要点(config.json)

- `sinkholeDomain`:拦截哪个域名(换域名只需改这里+跑一次 `make-cert.ps1`)
- `answerIP` / `allowFromCIDR`:**留空=全自动**(推荐,可移植);手工指定则覆盖自动
- `blockSubdomains`:false=只拦本体(默认);true=连 `*.域名` 一起拦
- `relay.auth`:**登录鉴权**——`enabled=true` 时所有访问先跳登录页;`accounts={账号:密码}`
  (明文,局域网自用;换新机器**先改密码**);`roles={admin:admin}` 声明管理员(删文件/清聊天),
  未列账号=普通用户;`enabled=false` 关闭登录(免登录直入)。
- **管理员模式**:三条路任一即管理员——①本机打开(127.0.0.1/本机网卡 IP,免登录直入);
  ②`roles` 里声明的管理员账号登录;③配了 `relay.token` 且带 token。管理员标题旁显示 🛡️ 徽章,
  可删任意文件、清空聊天;普通用户无删除/清空按钮(接口 403)。
  本机快速入口:双击桌面「中继站(管理员)」快捷方式,或项目根 `打开中继站(管理员).cmd`。
- `relay.proxy.blockPrivate`:true 时禁止转发内网地址(默认 false,便于看光猫/NAS 页)
- `upstreamDNS`:非拦截域名转发的上游(默认阿里 223.5.5.5 / 腾讯 119.29.29.29)
- `relay.dhcp`:**内置 DHCP 服务器**(替代已坏死的 ICS,无需系统共享):
  `{ "enabled": true, "gateway": "192.168.137.1", "mask": "255.255.255.0", "pool": "192.168.137.2-254", "leaseSec": 3600 }`。
  前提:热点网卡(如 `本地连接* 12`)手工设为 `gateway` 的静态 IP。
  设备连热点即自动拿到 IP+DNS(都指向本机),直接开 `http://iflytek.com`;
  同一设备几乎永远分到同一 IP(按 MAC 哈希,重启/重连不变)。

### 热点 DHCP:自建替代 ICS(说明)

- ICS 的"允许共享"在这台机上彻底报错(0x80040201),已弃用;热点广播仍由
  `hostednetwork`(计划任务 `sinkhole-hotspot`)负责,IP 分配改由本服务内置 DHCP 完成
- 收包绑 `0.0.0.0:67`(SO_REUSEADDR,与系统残留占用共存);应答走定向广播
  `192.168.137.255:68`,保证从热点网卡发出、不干扰家庭路由器网段
- 边界情况:若家庭路由器(而非热点)上某设备恰好发 DHCP DISCOVER 且路由器应答很慢,
  本服务也可能应答(设备被分到 137.x 会断网)——重新连一下路由器 WiFi 即恢复,
  路由器在线时其应答通常更快,该情况极少发生

## 让设备走你的 DNS(三选一)

1. **光猫/路由器 DHCP 下发**(全网生效,联通光猫见《联通光猫操作教程.md》,需超管)
2. **本机热点 + 内置 DHCP**(最快,插上 USB 无线网卡即可):热点(hostednetwork)
   + 本服务内置 DHCP 自动给手机发 `192.168.137.x`,无需 ICS/移动热点共享;手机连热点就进中继站
3. 单设备手动改 DNS 为本机 IP(临时用)

## 已知限制

- 浏览器 DoH(安全 DNS)/安卓私有 DNS/写死公共 DNS 的设备会绕过拦截
- 网页转发对**重 JS/登录态**站点效果有限(无 Cookie 保持、不执行复杂脚本的站点会缺内容);
  内网设备管理页、文档站、静态站体验好
- 本机 53 与 ICS/Hyper-V 共存,后绑定者收包——本服务延迟 30 秒自启且网卡变动自动重绑,正常
- DHCP 只在 `relay.dhcp.enabled=true` 且热点网卡已设好静态 IP 时工作;
  防火墙需放行 UDP 67 入站(默认防火墙关闭的机器无此要求)
- 中继文件永久保留在 `storage/`,注意磁盘

## 回滚/卸载

见 `uninstall-on-this-pc.ps1`,另需手动:路由器/光猫 DHCP 的 DNS 改回原值。
