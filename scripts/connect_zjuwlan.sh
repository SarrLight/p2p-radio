#!/bin/bash
# 连接板载无线网卡到 ZJUWLAN
# 用法: sudo bash connect_zjuwlan.sh

WIFI_IFACE="wlp3s0b1"

echo "=== 连接 $WIFI_IFACE 到 ZJUWLAN ==="
nmcli device wifi connect "ZJUWLAN" ifname "$WIFI_IFACE"

echo ""
echo "=== 连接后的 IP ==="
ip addr show "$WIFI_IFACE" | grep -E 'inet\s'

echo ""
echo "=== 路由表 ==="
ip route show
