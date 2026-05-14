# p2p-radio — PoC

最小可运行示例：在校园网内用浏览器实现 P2P 音频（mesh）。

快速运行：

1. 进入 `server` 并安装依赖：

```bash
cd server
npm install
npm start
```

2. 在浏览器打开 `http://localhost:3000/`，在两台或多台机器上加入同一房间（默认 `test`），允许麦克风访问，即可互听。
3. 页面里提供了麦克风和系统声音两个独立开关。系统声音需要在浏览器弹出的共享窗口里勾选音频共享。

手动验证：

1. 启动服务端后，在两个浏览器标签页或两个窗口里打开 `http://localhost:3000/`。
2. 两边都保持同一个房间名，例如 `test`。
3. 先在一边点击 `Join`，再在另一边点击 `Join`。
4. 允许麦克风权限后，页面会创建本地音频流；连接成功后，页面里的远端音频元素会出现，说明 P2P 音频连通。

自动验证：

1. 先启动服务端。
2. 在仓库根目录执行 `npm run e2e`。
3. 当前 E2E 会优先使用本机已安装的 Edge 或 Chrome；如果没有匹配的浏览器，会提示安装 Playwright Chromium，或者设置 `PLAYWRIGHT_CHROMIUM_PATH`。

说明：当前实现使用简单 mesh（每个客户端对每个其他客户端建立 PeerConnection），适合小规模测试（2-4 人）。要扩展到更多用户，请改用 SFU（例如 `mediasoup`）。
