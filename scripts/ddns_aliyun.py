#!/usr/bin/env python3
"""
阿里云 DDNS 自动更新脚本
监听指定网卡的 IP 变化，自动更新阿里云 DNS A 记录

用法:
  python3 ddns_aliyun.py                  # 交互式首次配置
  python3 ddns_aliyun.py --check          # 检查一次并更新
  python3 ddns_aliyun.py --status         # 查看当前状态

首次运行会创建配置文件 ~/.ddns_aliyun.json
"""

import os
import json
import sys
import hmac
import hashlib
import base64
import urllib.request
import urllib.parse
import time
import re
import subprocess
from datetime import datetime, timezone

CONFIG_PATH = os.path.expanduser("~/.ddns_aliyun.json")

# ── 阿里云 DNS API ───────────────────────────────────────────────────
ALIYUN_API = "https://dns.aliyuncs.com/"
API_VERSION = "2015-01-09"

def sign_request(params, access_key_secret):
    """生成 HMAC-SHA1 签名"""
    keys = sorted(params.keys())
    canonical = "&".join(f"{urllib.parse.quote(str(k), safe='')}={urllib.parse.quote(str(params[k]), safe='')}" for k in keys)
    string_to_sign = f"GET&{urllib.parse.quote('/', safe='')}&{urllib.parse.quote(canonical, safe='')}"
    h = hmac.new(
        (access_key_secret + "&").encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1
    )
    return base64.b64encode(h.digest()).decode("utf-8")

def call_aliyun(action, params, access_key_id, access_key_secret):
    """调用阿里云 DNS API"""
    common = {
        "Action": action,
        "AccessKeyId": access_key_id,
        "Format": "json",
        "Version": API_VERSION,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": str(int(time.time() * 1000000)),
        "SignatureVersion": "1.0",
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    all_params = {**common, **params}
    all_params["Signature"] = sign_request(all_params, access_key_secret)
    url = ALIYUN_API + "?" + urllib.parse.urlencode(all_params)
    
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))

# ── 获取本机 IP ──────────────────────────────────────────────────────
def get_interface_ip(ifname):
    """获取指定网卡的 IP 地址"""
    try:
        result = subprocess.run(
            ["ip", "-4", "addr", "show", ifname],
            capture_output=True, text=True, timeout=10
        )
        match = re.search(r'inet\s+(\d+\.\d+\.\d+\.\d+)/', result.stdout)
        if match:
            return match.group(1)
        return None
    except Exception as e:
        print(f"  [!] 获取网卡 {ifname} IP 失败: {e}", file=sys.stderr)
        return None

# ── 配置管理 ──────────────────────────────────────────────────────────
def load_config():
    if not os.path.exists(CONFIG_PATH):
        return None
    with open(CONFIG_PATH) as f:
        return json.load(f)

def save_config(config):
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)

def setup_interactive():
    """首次交互式配置"""
    print("=" * 55)
    print("  阿里云 DDNS 自动更新 - 首次配置")
    print("=" * 55)
    print()
    print("需要准备：阿里云 AccessKey（RAM 用户，权限：AliyunDNSFullAccess）")
    print("访问 https://ram.console.aliyun.com/users 创建")
    print()
    
    ak_id = input("AccessKey ID: ").strip()
    ak_secret = input("AccessKey Secret: ").strip()
    
    # 测试连接
    print("\n[*] 正在验证 AccessKey...")
    try:
        result = call_aliyun("DescribeDomains", {}, ak_id, ak_secret)
        if "Domains" not in result and "Message" in result:
            print(f"  [!] 验证失败: {result['Message']}")
            sys.exit(1)
        print(f"  [✓] 验证成功，已托管 {len(result.get('Domains', {}).get('Domain', []))} 个域名")
    except Exception as e:
        print(f"  [!] 网络错误: {e}")
        print("  请检查网络连接和 AccessKey 是否正确")
        sys.exit(1)
    
    # 列出网卡
    print("\n[*] 可用网络接口：")
    result = subprocess.run(["ip", "-4", "addr", "show"], capture_output=True, text=True, timeout=10)
    for line in result.stdout.split("\n"):
        if ":" in line and "LOOPBACK" not in line:
            name = line.split(":")[1].strip().split("@")[0]
            print(f"    {name}")
    
    ifname = input("\n校网 USB 无线网卡名称 (默认 wlxfc221c200148): ").strip() or "wlxfc221c200148"
    
    domain = input("域名 (示例: thid.top): ").strip() or "thid.top"
    sub = input("二级域名 (示例: zju-radio, 留空即 @): ").strip() or "@"
    rr = sub if sub != "@" else "@"
    
    port = input("服务端口 (默认 3000): ").strip() or "3000"
    
    # 获取当前 IP 确认
    current_ip = get_interface_ip(ifname)
    print(f"\n[*] 当前 {ifname} IP: {current_ip or '未获取到'}")
    
    config = {
        "access_key_id": ak_id,
        "access_key_secret": ak_secret,
        "interface": ifname,
        "domain": domain,
        "rr": rr,
        "port": int(port),
        "ttl": 600,
        "last_ip": current_ip,
        "last_update": None,
    }
    save_config(config)
    print(f"\n[✓] 配置已保存到 {CONFIG_PATH}")
    
    # 检查并创建/更新 DNS 记录
    print("\n[*] 正在检查 DNS 记录...")
    do_update(config)
    return config

# ── 核心更新逻辑 ──────────────────────────────────────────────────────
def get_record_id(config):
    """查询当前 DNS A 记录"""
    rr = config["rr"]
    domain = config["domain"]
    full_name = f"{rr}.{domain}" if rr != "@" else domain
    
    try:
        result = call_aliyun("DescribeSubDomainRecords", {
            "SubDomain": full_name,
            "Type": "A",
        }, config["access_key_id"], config["access_key_secret"])
        
        records = result.get("DomainRecords", {}).get("Record", [])
        return records[0] if records else None
    except Exception as e:
        print(f"  [!] 查询 DNS 记录失败: {e}")
        return None

def do_update(config, force=False):
    """检查并更新 DNS 记录"""
    ifname = config["interface"]
    current_ip = get_interface_ip(ifname)
    
    if not current_ip:
        print(f"  [!] 无法获取 {ifname} 的 IP 地址，跳过更新")
        return False
    
    if not force and config.get("last_ip") == current_ip:
        print(f"  [=] IP 未变化 ({current_ip})，跳过")
        return True
    
    record = get_record_id(config)
    
    if record:
        record_id = record["RecordId"]
        dns_ip = record["Value"]
        
        if dns_ip == current_ip:
            print(f"  [=] DNS 记录已是最新 ({current_ip})")
            config["last_ip"] = current_ip
            config["last_update"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            save_config(config)
            return True
        
        # 更新记录
        rr_val = config["rr"]
        print(f"  [~] 更新 DNS: {rr_val}.{config['domain']}  {dns_ip} → {current_ip}")
        try:
            call_aliyun("UpdateDomainRecord", {
                "RecordId": record_id,
                "RR": rr_val,
                "Type": "A",
                "Value": current_ip,
                "TTL": config.get("ttl", 600),
            }, config["access_key_id"], config["access_key_secret"])
            print(f"  [✓] DNS 更新成功")
            config["last_ip"] = current_ip
            config["last_update"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            save_config(config)
            return True
        except Exception as e:
            print(f"  [!] DNS 更新失败: {e}")
            return False
    else:
        # 新建记录
        rr_val = config["rr"]
        print(f"  [+] 新建 DNS 记录: {rr_val}.{config['domain']} → {current_ip}")
        try:
            call_aliyun("AddDomainRecord", {
                "DomainName": config["domain"],
                "RR": rr_val,
                "Type": "A",
                "Value": current_ip,
                "TTL": config.get("ttl", 600),
            }, config["access_key_id"], config["access_key_secret"])
            print(f"  [✓] DNS 记录创建成功")
            config["last_ip"] = current_ip
            config["last_update"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            save_config(config)
            return True
        except Exception as e:
            print(f"  [!] DNS 记录创建失败: {e}")
            return False

# ── 状态查看 ──────────────────────────────────────────────────────────
def show_status(config):
    ifname = config["interface"]
    current_ip = get_interface_ip(ifname)
    rr_val = config["rr"]
    full_name = f"{rr_val}.{config['domain']}" if rr_val != "@" else config["domain"]
    
    print(f"  域名:    {full_name}")
    print(f"  当前 IP: {current_ip or '未知'}")
    print(f"  网卡:    {ifname}")
    print(f"  端口:    {config.get('port', 3000)}")
    print(f"  上次 IP: {config.get('last_ip', 'N/A')}")
    print(f"  上次更新: {config.get('last_update', '从未')}")
    
    # 查询 DNS 记录
    record = get_record_id(config)
    if record:
        dns_ip = record["Value"]
        status = "✓ 一致" if dns_ip == current_ip else "✗ 需更新"
        print(f"  DNS 记录: {dns_ip} ({status})")
        print(f"  TTL:      {record.get('TTL', '?')}秒")
    else:
        print(f"  DNS 记录: 未找到")


# ── 主入口 ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    config = load_config()
    
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "--check":
            if not config:
                print("请先运行 python3 ddns_aliyun.py 进行首次配置", file=sys.stderr)
                sys.exit(1)
            success = do_update(config)
            sys.exit(0 if success else 1)
        elif cmd == "--status":
            if not config:
                print("尚未配置，请先运行 python3 ddns_aliyun.py", file=sys.stderr)
                sys.exit(1)
            show_status(config)
        elif cmd == "--force":
            if not config:
                print("尚未配置，请先运行 python3 ddns_aliyun.py", file=sys.stderr)
                sys.exit(1)
            success = do_update(config, force=True)
            sys.exit(0 if success else 1)
        else:
            print(f"用法:")
            print(f"  python3 ddns_aliyun.py             首次配置")
            print(f"  python3 ddns_aliyun.py --check     检查并更新")
            print(f"  python3 ddns_aliyun.py --force     强制更新")
            print(f"  python3 ddns_aliyun.py --status    查看状态")
    else:
        if config:
            print("已配置，运行 --check 检查更新，或 --status 查看状态")
            sys.exit(0)
        setup_interactive()
