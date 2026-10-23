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
| 🛡️ 身份组/配额 | `/admin` 管理页:按角色控权限(7 权限位存 `storage/roles.json` 热加载)+ 按账号月流量配额(超限 413,`storage/traffic.json` 月归零)+ 流量表/清零 |

外加:📝 跨设备文字便签。零第三方依赖(纯 Node 内置模块),含便携运行时,
**整个文件夹拷到任何 Windows 电脑一条命令部署**。

> ⚠️ 仅在你自己管理、有权配置的网络中使用。`iflytek.com` 是讯飞真实域名:
> - 默认**只拦精确域名**(`blockSubdomains: false`),`www./aiui.` 等子域不受影响;
> - 真实域名可能带 **HSTS**:访问过真站的设备需安装 `certs/iflytek.cer` 才不报错;
> - 聊天/文件/便签对局域网所有设备可见,属"信任网络"设计,勿放敏感资料;
> - 网页转发等于给局域网开了一台代理(可访问外网/内网页面),不想用可关
>   `relay.proxy.enabled=false`。

## 换电脑快速部署(插谁谁开)

**v10 起推荐入口:双击 `管理中心.bat`(免 exe、免装 Node、Win7 自适应)**

```text
1. 整个 iflytek-sinkhole 文件夹拷到新电脑任意位置(内含 runtime\node.exe,免装 Node)
2. 双击 管理中心.bat → 同意 UAC(拒绝则进"受限模式":查状态/改配置可用,装/卸/热点会提示)
   [1] 环境自检   [8] 安装/修复(3 任务+4 防火墙,全部指向本文件夹)
   [2] 启动服务   [5] 开热点(经典 SoftAP:自动选卡/自动上联网/ICS+DHCP 兜底)
   [a] 可视化管理台 → http://127.0.0.1:28790(网页配置/状态灯/日志/卸载演练)
   [9] 冲突治理   [u] 一键卸载(可连文件夹一起删)
3. 或把路由器/光猫 DHCP 下发的 DNS 指向本机 IP;设备浏览器访问 http://iflytek.com
```

命令行同效(等价于菜单,脚本调用/排障用):

```powershell
Set-Location <你的路径>\iflytek-sinkhole
.\管理中心.bat check        # 环境自检(节点/权限/配置/端口/任务/热点/冲突 一键体检)
.\管理中心.bat install      # 注册 3 个计划任务 + 4 条防火墙规则(指向本文件夹)
.\管理中心.bat start        # 启动服务(stop/restart 同理)
.\管理中心.bat serve --open # 可视化管理台
.\setup-on-this-pc.ps1      # 老路径:PowerShell 一条命令装机(仍可用)
```

- **DNS 应答全自动**:查询来自哪个网段,就回本机在那个网段的 IP(内网回内网卡、
  移动热点客户端回 `192.168.137.1`),换网络/换电脑不用改配置
- **白名单自动**:默认放行本机所有网卡网段(防公网滥用的意图保留,IPv6 直连拒绝)
- 网卡插拔、热点开关后 15 秒内自动感知并重新抢占 53 端口(与 ICS 共存问题自愈)
- 卸载:`管理中心.bat → [u]`一键卸载(停服务/删 3 任务/删防火墙/停热点,可选连文件夹一起删;
  存储数据默认保留);命令行 `.\管理中心.bat uninstall --dry` 先演练
- 系统没装 Node 也不想用自带运行时:`.\setup-on-this-pc.ps1 -BundleRuntime`
  (从 npmmirror 下载便携版 Node 到 `runtime\`)

## 一键安装包(exe)与 GitHub 仓库

> **路线变更(2026-10-22)**:exe 路线**暂时舍弃**(实测 安装后卸不掉 / exe 壳打不开 /
> Win7 不兼容三个硬伤)。新装与日常管理一律走 **`管理中心.bat` + 本地网页管理台**;
> `make-installer.ps1`/`中继站管理器.exe`/`卸载中继站.exe` 源码保留但不再维护,见下文历史说明。

**源码仓库(公开)**:https://github.com/qingshanjiluo/iflytek-sinkhole

```powershell
git clone https://github.com/qingshanjiluo/iflytek-sinkhole.git
cd iflytek-sinkhole
.\setup-on-this-pc.ps1     # 管理员 PowerShell,一条命令部署
```

**打一个带安装向导的安装包**(Windows 10/11 x64 双击即装;捆绑的 Node 24 不支持 Win7/8):

```powershell
.\make-installer.ps1              # 产物 dist\iflytek-sinkhole-setup.exe(捆绑 99MB 便携 Node)
.\make-installer.ps1 -NoRuntime    # 不捆 Node(新机器安装时 setup 再下载)
.\make-installer.ps1 -NoData       # 不打包 storage 数据(装成全新空库)
```

双击 exe 后的流程:解压 → UAC 提权 → **安装向导窗**(可改:安装目录 / 是否导入原机数据 /
热点 SSID·密码 / 管理员账号)→ 铺开目录 → 应用配置 → `setup-on-this-pc.ps1`(证书/防火墙/
开机自启/启动服务)→ 结果页(打开 管理器.exe / 打开 http://iflytek.com)。

- **包内带全配置**:根文件 + `public\*.html` + `certs\iflytek.pfx/*.cer`(证书指纹不变,设备
  已装的信任证书继续有效)+ `data.zip`(storage:文件列表/聊天/会话/身份组/流量,向导可选导入)
- **中继站管理器.exe —— 已舍弃(历史)**:原功能全部并入 `管理中心.bat` 菜单 + 网页管理台
  (启停/状态/网卡下拉/热点 SSID·密码/配置对话框→网页「配置」页,保存即写 config.json 并可重启);
  exe 壳在部分机器"无法运行",且 Win7 无解——这就是换 bat+js 的动因
- 安装包用 Windows 自带 **IExpress** 打包(零第三方依赖):解压会拍平子目录,由 `install.cmd`(GBK+CRLF)
  按扩展名重建目录;管理器 exe 用 .NET Framework 自带 csc 编译的 WinExe 壳(Win10/11 直接可跑)
- **构建机限制**:SED 必须 GBK(只能在中文 Windows 构建)、构建路径不能含空格
  (IExpress `/N` 不吃引号;脚本自动选 `TEMP`,含空格回退 `C:\iflytek-si-build`)
- 自动化测试环境变量:`SKIP_WIZARD=1`(不弹向导,默认导数据)、`INSTALL_DIR=目录`、
  `SKIP_SETUP=1`(只铺文件)、`AUTO_EXIT=1`(不弹结果窗/不 pause)
- 卸载:**`管理中心.bat → [u]`**(v10 起,见文末「回滚/卸载」);旧 `卸载中继站.exe` 随 exe 路线一并舍弃

> ⚠️ 仓库是**公开**的:`config.json` 含登录密码与热点 SSID/密码、`home-wifi-profile.xml` 含
> 家里 WiFi 凭据——**换机部署后务必改密码**;不想公开就去仓库 Settings 改 Private。

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
| `public/admin.html` | 管理页 `/admin`:身份组+权限范围、账号分组、本月流量(仅管理员) |
| `storage/` | `files/`+`meta.json` 文件;`chat.json` 聊天;`sessions.json` 会话;`roles.json` 身份组权限;`traffic.json` 月流量 |
| `runtime/node.exe` | 便携 Node 运行时(v24 x64),换机免装;**Win7 放 Node14 进 `runtime-win7\`** |
| `管理中心.bat` | **v10 首选入口**:UAC 自适应(拒绝提权→受限模式兜底) + 节点三级探测 + 交互菜单(纯 ASCII,任意代码页不乱码) |
| `mgmt.js` | 管理中心核心(零依赖 node):环境自检/服务启停/热点(纯 netsh)/任务安装/冲突归位/一键卸载/网页管理台 |
| `keepalive.js` | 保活任务 node 版(Win7 PS2.0 无 Resolve-DnsName,老 PS 版会静默失效) |
| `public/mgmt.html` | 可视化管理台前端(`http://127.0.0.1:28790`:状态灯/网页配置/日志/卸载演练) |
| `make-cert.ps1` / `setup-firewall.ps1` / `register-autostart.ps1` | 单项脚本 |
| `setup-on-this-pc.ps1` / `uninstall-on-this-pc.ps1` | 一键装机/卸载(PowerShell 老路径,仍可用) |
| `uninstall-gui.ps1` | (旧 exe 路线,暂舍)卸载向导源 |
| `make-installer.ps1` | (旧 exe 路线,暂舍)IExpress 安装包构建 |
| `setup-wizard.ps1` | (旧 exe 路线,暂舍)安装向导 |
| `launcher.ps1` | (旧 exe 路线,暂舍)管理器 GUI 源 |
| `start.ps1` / `stop.ps1` | 手动后台启停(按 `--svc-sinkhole` 标记识别进程) |
| `test-chat.js` | 聊天室双客户端自测 |
| `test-dhcp.js` | DHCP 全流程自测(本机模拟手机 DISCOVER→OFFER→REQUEST→ACK) |

## API 一览

```
GET    /                  门户(镜像开启=实时镜像原官网;关闭=中继站页面)
/relay                    中继站后台(门户上点 logo 进入;mirror.door 可改)
POST   /api/upload        头 x-file-name=<encodeURIComponent(名字)>,body=原始字节
GET    /api/files         文件列表
GET    /f/<id>            下载(单段 Range 续传;?inline=1 预览,前端「看图/预览/读书」改新页打开)
GET    /api/zip?ids=a,b   多文件打包成 zip 一次下载(无 File System Access 的学习机兜底)
DELETE /api/files/<id>    删除
GET/PUT /api/note         共享文字便签(≤1MB)
WS     /ws/chat?name=昵称  聊天室(hello含历史/msg/presence;历史500条持久化)
POST   /api/chat/clear    清空聊天
GET/POST /p/<urlencode(URL)>  网页转发浏览(HTML 改写 + **运行时 shim 改写页面 JS 的 fetch/XHR/media src**
                              + 音视频 Range/206 流式透传 + 反盗链 referer + GBK 转码)
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
GET    /api/info           站点信息(admin/auth 状态 + perms 身份权限 + usage 本月流量);/api/files 每项含 pv 预览元数据
GET    /admin              管理页(serveIndexPage 同款鉴权,canAdmin 才行)
GET/POST /api/admin/roles  读/存身份组(defaultPerms + roles{perms,monthlyQuotaMB})→ storage/roles.json,保存即热生效
GET/POST /api/admin/accounts  账号→身份组:GET 列表,POST 改归属(写回 config.json relay.auth.roles,重启生效)
GET    /api/admin/traffic   本月流量表(逐账号 up/down/配额占比)
POST   /api/admin/traffic/reset  流量清零(body {user}=单个 / {}=全部)
GET    /api/admin/visits?limit=200  局域网访问记录(04 管理页;新→旧;admin)
POST   /api/admin/visits         清空访问记录(留痕:时间/IP/路径/码/90秒同设备同路径合并/UA;
                                 过滤 /api 轮询+系统探测+/p/ 子资源;存 storage/visits.json;
                                 上限 relay.visitsMax 默认1000,relay.visits=false 关闭)
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
- **身份组+权限+流量配额**(管理页 `/admin`,入口=本机直入/admin 账号/授了 admin 权限的组):
  - 权限位 `upload/download/preview/chat/web/delete/admin` 存 `storage/roles.json`;
    `defaultPerms`=未配置账号的默认权限(默认前五个,不含 delete/admin);自定义组
    `roles.组名={perms:null=跟随默认, monthlyQuotaMB:0=不限}`,**保存即热加载生效**
  - 内置组 `admin`=全权限永不设限(防 roles.json 削权提权);账号归属仍在
    `config.json relay.auth.roles`(管理页下拉改,改完重启服务)
  - 月配额=上传+下载合计(MB):预检(超剩余直接拒)+流中(到线中断)双层 413 `quotaExceeded`;
    每月 1 日自动归零;本机/token/管理路径与未开登录(`auth.enabled=false`)不设限
  - 伪装门户对匿名可见——web 权限只管 `/p/` 网页中转;顶栏「流量 x/y MB」小标签 = `/api/info.usage`
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

## v10.1 审计加固(2026-10-23)

- **`/p/` 网页转发 SSRF 基线**:内网/本机地址一律拒绝(127/10/172.16-31/192.168/169.254/localhost/
  纯主机名/`.local|.lan` 等),公网页面照常转发——防止经中继站代理访问路由器管理页/光猫/云元数据
- **保活 keepalive v3**:`53 无应答` 不再直接判死——relay `/api/info` 复核(53 被抢/绑定失败时服务
  还活着→只提示不重启),双无且连续 2 轮 + 距上次重启 ≥10 分钟冷却才动手(2026-10-22 实测 30 分钟
  连杀 4 次的教训);事件循环活但 53 外占的警告 1 小时最多 1 条
- **服务日志轮转**:`sinkhole.log` >8MB 自动换代为 `sinkhole.log.1`(旧 .1 覆盖),管理台日志页可切换
- **局域网 DHCP 抢答可见化**:客户端 REQUEST 点名别的 DHCP 服务器时记账 `storage/dhcp-rivals.json`,
  管理中心体检直接给 [!!] 提示"路由器 DHCP 还在抢答→教程第 1 步"——10-22 实测日志里已有此现象
- **管理台新增「访问记录」标签**:直读中继站 `storage/visits.json`(时间/IP/次数/状态码/路径/UA,
  最新在前,5 秒自动刷新)
- **mgmt 菜单 E2E 逃生口**:`MGMT_MENU_STDIN=文件` 按行喂菜单选择,供非交互环境冒烟验证分发逻辑
- 路由快审结论:文件下载走 `[0-9a-f]{16}` id 白名单、epub 预览同款 id 校验、`/api/logs` 拒 `..` 穿越、
  上传名 `sanitizeName` 剔除 `\ / : * ? " < > |` 与控制符——无路径穿越面

## v10.2 双模式投屏(2026-10-23)

**模式1(原有,小优化)**:平板/学习机自己开页逐页中转,`04 网页中转` 新增「模式1」入口提示与直达跳转。

**模式2(新增,电脑开页→平板反控)**:电脑浏览器打开 `/cast/host`(中继站 04 区有入口说明),
地址栏输入网址(公网自动走 `/p/` 中转,同源可反控;内网地址直开)→ 点「● 开始投屏」→
共享选择器选**当前标签页**。平板/手机开 `/cast`(或中继站首页「模式2」按钮):

- **画面**:电脑端 `getDisplayMedia` 自拍 → WebRTC DataChannel 单向推 JPEG 帧(≤1280 宽、
  ~12fps、toBlob 0.55 质量;后台标签 240ms 定时器兜底,不依赖 rAF);观看端画 canvas
- **反控**:平板在画布上**点按/拖动滚动/滚轮/双击**→ 归一化坐标经 `/ws/cast` WS 回传电脑
  → 电脑端递归同源 iframe 命中真实元素,合成 Pointer/Mouse/Wheel 事件派发(50 次/秒限流,
  观看者只许 8KB 控制帧防风暴);工具条:后退/刷新/上下滚/网址导航/虚拟打字(含 Enter 提交、
  Backspace 删字)/Esc;黑屏等画面时也可反控(不依赖收到帧)
- **协议**:WS `/ws/cast` 复用手写 RFC6455 升级栈,与聊天共存;控制走 WS、画面走 WebRTC
  (ICE 仅主机候选,answer/trickle 也走 WS——同机回环不穿 NAT);投屏台后上线自动顶掉旧的
- **权限**:与 `/p/` 同门槛(`web` 权限 + 登录);SSRF 内网基线同样作用于投屏导航
- **开机热点自愈**:`sinkhole-hotspot` 任务改 `hotspot --auto --retry`,无网卡/网卡未枚举时
  最多重试 3 次(每次隔 15 秒)——修开机任务 Last Result=1 后热点不再"静默失败"

**v10.2.2 真机 E2E 修复(同日)**:新增双 Chrome 真实端到端测试 `test-cast-browser.js`(11 项),
修出四个此前纸面审查漏掉的硬伤——①投屏页 WS 地址漏 `location.host`(浏览器把 `ws` 当主机名,
1006 永远连不上);②relay 漏转发 WebRTC 信令 offer/answer/trickle(信令从未通过中继);
③`.then(iceDone)` 误传 `undefined` 致 ICE 链静默断掉 offer 从未发出;④可见标签页发帧器被
`document.hidden` 门死(平板可见时永远黑屏)。修后 11/11 全绿:双端连通、投屏、WebRTC
connected、1280px 画面送达、反控光标闭环。

## 已知限制

- 浏览器 DoH(安全 DNS)/安卓私有 DNS/写死公共 DNS 的设备会绕过拦截
- 网页转发对**重 JS/登录态**站点效果有限(无 Cookie 保持、不执行复杂脚本的站点会缺内容);
  内网设备管理页、文档站、静态站体验好
- 本机 53 与 ICS/Hyper-V 共存,后绑定者收包——本服务延迟 30 秒自启且网卡变动自动重绑,正常
- DHCP 只在 `relay.dhcp.enabled=true` 且热点网卡已设好静态 IP 时工作;
  防火墙需放行 UDP 67 入站(默认防火墙关闭的机器无此要求)
- 中继文件永久保留在 `storage/`,注意磁盘

## 回滚/卸载

**推荐:双击 `管理中心.bat` → `[u]` 一键卸载**(自动弹 UAC):

- **演练先行**:菜单选 1(只列清单不执行),或 `.\管理中心.bat uninstall --dry`
- **执行**:停全部服务进程(含别的副本)→ 删 3 个计划任务(`iflytek-sinkhole`+`sinkhole-hotspot`+
  `sinkhole-keepalive`,防保活复活)→ 删 4 条防火墙规则 → 关热点;**文件与 storage 数据默认保留**
- 子选项:「卸载并删除本文件夹」(延时自删,被占用留 `_残留.txt` 重启后再删)、清本机证书(`--cert`);
  网页管理台「维护/卸载」页同样有演练+执行
- 旧 `卸载中继站.exe` / `uninstall-on-this-pc.ps1` 仍可用,但**推荐走 bat**(多副本感知:会连
  C:\Program Files 等别处的残留服务一起停)

> v9 实证教训:旧卸载只删第 1 个任务 → `sinkhole-keepalive` 每 5 分钟把已删服务复活 → "卸不掉";
> v10 在 bat/网页/CLI 三处都先删保活任务再停服务,顺序固化。

另需手动:路由器/光猫 DHCP 的 DNS 改回原值;要清数据自己删 `storage\`。

## Windows 7 适配(v10)

- **Node 门禁**:捆绑 Node 24 只支持 Win10+;Win7/8 放 **Node14 便携版 `node.exe` 到
  `runtime-win7\`**,`管理中心.bat` 三级探测(`runtime-win7 → runtime → PATH`)每级先
  `-v` 冒烟,跑不起来的自动换下一级——"自动适应"就是这层。
- **PowerShell 降级**:Win7 自带 PS2.0 没有 Get-CimInstance/Get-NetAdapter/Get-ScheduledTask/
  Resolve-DnsName。v10 管理面(mgmt.js/keepalive.js)**全部只用 netsh/schtasks/taskkill/certutil/wmic**,
  进程探测三级回退(CIM→WMI→wmic),PowerShell 仅 ICS 共享一步(PS2 兼容 COM 语法,失败自动退化
  "AP 口静态 192.168.137.1")。
- **证书**:`New-SelfSignedCertificate` Win7 没有 → 新机直接拷 `certs\` 目录(随文件夹走,检查项会提示)。
- **编码**:bat 纯 ASCII 无代码页依赖;中文由 node 直写控制台(WriteConsoleW),GBK/UTF-8 控制台都不乱码。
- 网页管理台需较新浏览器;Win7 只有 IE11 时用菜单(纯命令行,零依赖)。
