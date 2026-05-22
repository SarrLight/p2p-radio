#!/bin/bash
# p2p-radio Caddy 反向代理部署脚本
# 用法: sudo bash setup_caddy.sh

set -e

CADDYFILE="/etc/caddy/Caddyfile"

echo "=== 1. 给 caddy 用户添加证书读取权限 ==="
setfacl -m u:caddy:rx /home/songxingguang
setfacl -m u:caddy:rx /home/songxingguang/projects
setfacl -m u:caddy:rx /home/songxingguang/projects/p2p-radio
setfacl -m u:caddy:rx /home/songxingguang/projects/p2p-radio/server
setfacl -m u:caddy:r  /home/songxingguang/projects/p2p-radio/server/cert.pem
setfacl -m u:caddy:r  /home/songxingguang/projects/p2p-radio/server/key.pem

echo "=== 2. 写入 Caddy 配置 ==="
cat > "$CADDYFILE" << 'CADDY'
# 主站点：p2p-radio
zju-radio.thid.top {
    tls /home/songxingguang/projects/p2p-radio/server/cert.pem /home/songxingguang/projects/p2p-radio/server/key.pem
    reverse_proxy localhost:3000
}
CADDY

echo "=== 2. 检查配置 ==="
caddy validate --config "$CADDYFILE"

echo "=== 3. 格式化配置 ==="
caddy fmt --overwrite "$CADDYFILE"

echo "=== 4. 重启 Caddy ==="
systemctl restart caddy
systemctl status caddy --no-pager | head -10

echo ""
echo "=== 完成！==="
echo "访问 https://zju-radio.thid.top （不带端口）"
