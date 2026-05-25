# P2P Radio

校园网 P2P 音频电台。台长在一端播放音乐，听众在另一端实时收听。纯浏览器端，无需安装 App。

## 快速开始

```bash
cd server
npm install
npm start
```

浏览器打开 `http://localhost:3000`。

### 启用 HTTPS（远程主播必需）

主播如果不是用 `localhost` 访问，浏览器会拒绝麦克风/系统音频权限。需要启用 HTTPS：

```bash
cd server
node generate-cert.js   # 生成 CA + 服务器证书，只需一次
npm start               # 自动检测证书，输出 https://…
```

证书是自签名的。**只需一次**：把 `server/ca-cert.crt` 发给每台设备安装：

| 平台 | 操作 |
|---|---|
| Windows | 双击 → 安装证书 → 受信任的根证书颁发机构 |
| macOS | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca-cert.crt` |
| Android | 设置 → 安全 → 加密与凭据 → 从存储设备安装 |
| iOS | Safari 下载 ca-cert.crt → 允许 → 设置 → 通用 → VPN与设备管理 → 安装 |

安装后浏览器不再提示"不安全"，锁图标正常显示。

## 使用说明

### 角色

| 角色 | 干什么 | 需要权限 |
|---|---|---|
| **主播** | 播放音乐或说话 | 麦克风 / 系统音频 |
| **听众** | 收听电台 | 无 |

### 听众

1. 页面加载后看到**活跃电台列表**，点击电台名自动填入
2. 角色选择中，如果电台已有主播，"主播"按钮会被锁定（删除线），只能以听众身份加入
3. 点击"加入" → 立即收听，无任何权限弹窗
4. 播放卡片显示收听电平；表情栏可发送互动表情（😭👍❤️🥰🥳）；点击"🔊 收听中"可静音
5. 点红色"离开"按钮退出

### 主播

1. 选择"主播"角色，输入电台名（或从列表选择），点击"加入"
2. 加入后麦克风**默认关闭**，点击"麦克风：关"按钮开启
3. 点击"系统声音：关"开启系统音频共享——浏览器弹窗要求选择一个窗口，**勾选"共享音频"**，视频画面会被立刻丢弃
4. 状态栏会显示"画面已丢弃"作为确认
5. 播放卡片显示输入电平（麦克风 + 系统），确认音频正在发送
6. 诊断面板展开后显示 `📤 Out` 码率 > 0，表示正在推流

### 表情互动

加入电台后播放卡片底部出现表情栏。点击表情发送给房间内所有人，屏幕中出现浮动上升动画。计数由服务端统一管理，后来加入的用户也能看到累计数。

### 页面刷新

刷新页面后自动以相同角色重新加入原房间。非 iOS 平台直接恢复播放；iOS Safari 会显示"👆 点击屏幕继续收听"——点一下屏幕即恢复。

---

## 开发者指南

### 架构

```
浏览器 A (主播) ────WebRTC (P2P)────→ 浏览器 B (听众)
     │                                      │
     └── WebSocket ─── 信令服务器 ── WebSocket ─┘
                       (Node.js)
                       ├── HTTP (3000)    静态文件 / API
                       ├── WebSocket      信令 + 表情广播
                       ├── UDP (3478)     STUN
                       ├── HTTPS (可选)   自签名证书
                       └── 访问日志       /var/log/p2p-radio/access.log
```

音频流**不走服务器**，P2P 直连。服务器只做信令和 STUN。

### 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS，零框架，零构建 |
| 服务端 | Node.js + Express + ws |
| 实时通信 | WebRTC (RTCPeerConnection) |
| 音频编码 | Opus 立体声 256kbps，FEC 前向纠错 |
| STUN | 内嵌（无需外部 STUN 服务器） |
| 测试 | Playwright |

### 项目结构

```
server/
  signaling.js      信令 + STUN + 统计 + 访问日志 (475 行)
  generate-cert.js  自签名 CA + 服务器证书生成
  package.json

client/
  index.html         UI（深色模式，毛玻璃卡片）
  app.js             WebRTC + 音频管线 + 诊断 + 重连
  modules/
    state.js         全局状态 + DOM 引用
    ui.js            烟花 / 电平表 / 反应动画
    room-ui.js       电台列表轮询 + 站点统计
    room.js          加入/离开房间逻辑
    ws.js            WebSocket 信令连接 + 重连
    peer.js          RTCPeerConnection 管理
    audio.js         麦克风 / 系统音频捕获
    sdp.js           SDP 操作（Opus 音乐模式注入）
    stats.js         WebRTC 统计面板

e2e/
  e2e_test.js       WebRTC 连通性测试
  stress_test.js    多听众并发压力测试

docs/
  spec.md           项目愿景（校园电台地图）
```

### 关键设计决策

**WebRTC 网状拓扑 (Mesh)**：每个客户端直连所有其他客户端。适合 2-20 人。超过这个规模需要 SFU（如 mediasoup），主播上行带宽将成为瓶颈（每个听众 ≈ 320kbps）。

**单主播限制**：服务端保证每个房间只有一个主播。第二个选"主播"加入的人自动降级为听众。

**Opus 音乐模式**：默认 Opus 运行在 VOIP 模式（高通滤波 ~80Hz，单声道，低码率）。代码在每次 SDP 协商时注入 `stereo=1;maxaveragebitrate=256000;useinbandfec=1` 切换到音乐模式。

**iPad Safari 适配**：
- `<audio>` 元素 autoplay 被 Safari 阻止 → 用 Web Audio API 播放
- `AudioContext.resume()` 无用户手势时永久挂起 → 刷新后显示"点击继续收听"遮罩
- Web Audio 路由 WebRTC 流到听筒 → 需耳机（系统限制，无法绕过）

**听众 Web Audio 策略**：
- 初始 `ontrack`：`<audio>` 元素（Chrome/Edge/Android 上 autoplay 免检）
- 重协商 `ontrack`（主播重进后开麦）：`<audio>` 被拒 → 自动切 Web Audio
- iOS Safari：始终 Web Audio

### 已实现功能

- [x] P2P 音频传输（Mesh）
- [x] 主播/听众角色分离，单主播限制
- [x] 系统音频捕获（`getDisplayMedia`，视频即刻丢弃）
- [x] 内嵌 STUN 服务器（校园网跨子网）
- [x] Opus 音乐模式（立体声 256kbps + FEC）
- [x] 抖动缓冲（150-500ms 自适应）
- [x] 活跃电台列表 + 自动发现
- [x] 主播按钮智能锁定（已有主播时）
- [x] 表情互动（😭👍❤️🥰🥳）+ 服务端计数 + 烟花 🎆
- [x] 静音按钮
- [x] 播放电平表（听众）/ 输入电平表（主播）
- [x] WebSocket 断线重连（指数退避）
- [x] ICE 连接失败自动重启
- [x] 页面刷新自动重入（localStorage + pageshow）
- [x] iPad Safari 兼容（Web Audio 播放 + 手势解锁）
- [x] 诊断面板（ID、丢包、RTT、抖动、缓冲、码率）
- [x] HTTPS 自签名 CA 证书生成
- [x] 多听众压力测试脚本（Playwright）
- [x] 深色 UI + 毛玻璃卡片
- [x] **站点统计** — header 显示今日累计到访人数和电台数
- [x] **访问日志文件** — `/var/log/p2p-radio/access.log` 记录 VISIT、ROOM CREATE、ROOM END
- [x] **HTTP 日志降噪** — 轮询接口（`/api/rooms`, `/api/stats`）不在 stdout 刷屏
- [x] **反向代理真实 IP** — WebSocket 连接经 Caddy 代理后正确读取 X-Forwarded-For

### 待实现

- [ ] TURN 中继（coturn）—— 对付 Symmetric NAT
- [ ] 多主播轮流（当前主播离开后自动移交）
- [ ] 校园地图 UI（spec.md 中的"空间沙盘"）
- [ ] Vue 3 / Vite 重构
- [ ] 录音 / 回放
- [ ] 多语言（i18n）
