#!/bin/bash
set -e

SERVICE_FILE="/etc/systemd/system/p2p-radio.service"

echo ""
echo "=== 配置 CC98 OAuth 到 p2p-radio 服务 ==="
echo ""

# 1. 备份
echo "[1/4] 备份原服务文件..."
sudo cp "$SERVICE_FILE" "${SERVICE_FILE}.bak"
echo "  ✅ 已备份 -> ${SERVICE_FILE}.bak"

# 2. 写入新配置
echo "[2/4] 写入新配置..."
sudo tee "$SERVICE_FILE" > /dev/null << 'SERVICECONTENT'
[Unit]
Description=p2p-radio WebRTC Signaling Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=songxingguang
Group=songxingguang

WorkingDirectory=/home/songxingguang/projects/p2p-radio/server

Environment=REVERSE_PROXY=true
Environment=PORT=3000
Environment=LOG_LEVEL=info
Environment=CC98_CLIENT_ID=7b753c19-aad3-4f7e-4184-08debacdf9cd
Environment=CC98_CLIENT_SECRET=be09bf...node signaling.js

# Logging
StandardOutput=journal
StandardError=journal

# Restart on failure
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICECONTENT
echo "  ✅ 已写入（含 CC98 凭据 + 固定 SESSION_SECRET）"

# 3. 重启服务
echo "[3/4] 重新加载 systemd + 重启服务..."
sudo systemctl daemon-reload
sudo systemctl restart p2p-radio.service
echo "  ✅ 服务已重启"

# 4. 确认状态
echo "[4/4] 检查服务状态..."
sleep 2
sudo systemctl status p2p-radio.service --no-pager | head -15
echo ""
echo "=== 完成！刷新页面重新用 CC98 登录即可 ==="
echo ""
