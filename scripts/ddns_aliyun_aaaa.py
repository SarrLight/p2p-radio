#!/usr/bin/env python3
"""为 DDNS 添加 AAAA 记录（IPv6）"""
import json, hmac, hashlib, base64, urllib.request, urllib.parse, time, os
from datetime import datetime, timezone
import subprocess, re

CONFIG_PATH = os.path.expanduser("~/.ddns_aliyun.json")
ALIYUN_API = "https://dns.aliyuncs.com/"
API_VERSION = "2015-01-09"

def sign_request(params, secret):
    keys = sorted(params.keys())
    canonical = "&".join(f"{urllib.parse.quote(str(k), safe='')}={urllib.parse.quote(str(params[k]), safe='')}" for k in keys)
    string_to_sign = f"GET&{urllib.parse.quote('/', safe='')}&{urllib.parse.quote(canonical, safe='')}"
    h = hmac.new((secret + "&").encode(), string_to_sign.encode(), hashlib.sha1)
    return base64.b64encode(h.digest()).decode()

def call_aliyun(action, params, ak_id, ak_secret):
    common = {
        "Action": action, "AccessKeyId": ak_id, "Format": "json",
        "Version": API_VERSION, "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": str(int(time.time() * 1000000)),
        "SignatureVersion": "1.0",
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    all_params = {**common, **params}
    all_params["Signature"] = sign_request(all_params, ak_secret)
    url = ALIYUN_API + "?" + urllib.parse.urlencode(all_params)
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

def get_ipv6(ifname):
    try:
        r = subprocess.run(["ip", "-6", "addr", "show", ifname], capture_output=True, text=True, timeout=10)
        # 用 stable 地址（基于 MAC），排除临时地址和链路本地
        for line in r.stdout.split("\n"):
            m = re.search(r'inet6\s+([0-9a-f:]+)/\d+\s+.*global dynamic mngtmpaddr', line)
            if m:
                return m.group(1)
        return None
    except:
        return None

with open(CONFIG_PATH) as f:
    cfg = json.load(f)

ak_id = cfg["access_key_id"]
ak_secret = cfg["access_key_secret"]
domain = cfg["domain"]
rr = cfg["rr"]
full = f"{rr}.{domain}" if rr != "@" else domain

ipv6 = get_ipv6(cfg["interface"])
if not ipv6:
    print(f"[!] 未找到 {cfg['interface']} 的 IPv6 地址")
    exit(1)
print(f"[*] 本机 IPv6: {ipv6}")

# 查询已有 AAAA 记录
result = call_aliyun("DescribeSubDomainRecords", {
    "SubDomain": full, "Type": "AAAA"
}, ak_id, ak_secret)
records = result.get("DomainRecords", {}).get("Record", [])

if records:
    rec = records[0]
    if rec["Value"] == ipv6:
        print(f"[=] AAAA 记录已是最新 ({ipv6})")
    else:
        print(f"[~] 更新 AAAA: {rec['Value']} → {ipv6}")
        call_aliyun("UpdateDomainRecord", {
            "RecordId": rec["RecordId"], "RR": rr,
            "Type": "AAAA", "Value": ipv6, "TTL": 600,
        }, ak_id, ak_secret)
        print(f"[✓] AAAA 更新成功")
else:
    print(f"[+] 新建 AAAA 记录: {full} → {ipv6}")
    call_aliyun("AddDomainRecord", {
        "DomainName": domain, "RR": rr,
        "Type": "AAAA", "Value": ipv6, "TTL": 600,
    }, ak_id, ak_secret)
    print(f"[✓] AAAA 记录创建成功")
