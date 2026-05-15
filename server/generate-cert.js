// Generate a CA + server certificate so browsers trust the LAN HTTPS site.
// Users install the CA cert ONCE per device, then all server certs are trusted.
//
//   node generate-cert.js                    → generate CA + server cert
//   node generate-cert.js --ca-only          → only regenerate CA
//
// After running, distribute "ca-cert.crt" to every listener's device and
// install it (double-click on Windows, Keychain on macOS, etc.).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const caKey = path.join(dir, 'ca-key.pem');
const caCert = path.join(dir, 'ca-cert.pem');
const caCrt = path.join(dir, 'ca-cert.crt');     // .crt for easy Windows install
const serverKey = path.join(dir, 'key.pem');
const serverCert = path.join(dir, 'cert.pem');
const serverCsr = path.join(dir, 'server.csr');

// Try common openssl paths
const opensslPaths = [
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
];
let openssl = null;
for (const p of opensslPaths) {
  try { execSync(`"${p}" version`, { stdio: 'ignore' }); openssl = p; break; } catch (_) {}
}
if (!openssl) {
  console.error('未找到 openssl。请安装 Git for Windows。');
  console.error('https://git-scm.com/download/win');
  process.exit(1);
}
console.log(`openssl: ${openssl}`);

const caOnly = process.argv.includes('--ca-only');

// ── Step 1: CA (skip if exists) ────────────────────────────────────
if (!fs.existsSync(caKey) || !fs.existsSync(caCert)) {
  console.log('创建 CA 证书…');
  execSync(`"${openssl}" req -x509 -newkey rsa:2048 -keyout "${caKey}" -out "${caCert}" ` +
    `-days 3650 -nodes -subj "/CN=P2P Radio CA/O=P2P Radio/C=CN"`, { stdio: 'inherit' });
  // Copy to .crt for Windows double-click install
  fs.copyFileSync(caCert, caCrt);
  console.log('CA 已创建: ca-cert.pem + ca-cert.crt');
  console.log('');
  console.log('=== 重要 ===');
  console.log('将 ca-cert.crt 发送给每台需要访问的设备的用户，让他们安装：');
  console.log('  Windows: 双击 ca-cert.crt → 安装证书 → 受信任的根证书颁发机构');
  console.log('  macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca-cert.crt');
  console.log('  Android: 设置 → 安全 → 加密与凭据 → 从存储设备安装 → 选择 ca-cert.crt');
  console.log('  iOS:     用 Safari 下载 ca-cert.crt → 允许 → 设置 → 通用 → VPN与设备管理 → 安装');
  console.log('');
}

if (caOnly) {
  console.log('已跳过服务器证书生成 (--ca-only)。');
  process.exit(0);
}

// ── Step 2: Server cert signed by CA ───────────────────────────────
console.log('签发服务器证书…');

// Read local IPs for SAN (Subject Alternative Names)
const os = require('os');
const ips = [];
const ifaces = os.networkInterfaces();
for (const [, entries] of Object.entries(ifaces)) {
  for (const e of entries || []) {
    if (e.family === 'IPv4' && !e.internal) ips.push(e.address);
  }
}

// Build SAN string: IP:192.168.1.5,IP:10.0.0.3,DNS:localhost
const sanEntries = ['DNS:localhost', 'DNS:p2p-radio.local', ...ips.map(ip => `IP:${ip}`)];
const san = sanEntries.join(',');

// Create extension config for SAN
const extConf = path.join(dir, 'san.cnf');
fs.writeFileSync(extConf,
  '[req]\ndistinguished_name=req\n[req]\n' +
  '[v3_ext]\nsubjectAltName=' + san +
  '\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n'
);

// Generate server key + CSR
execSync(`"${openssl}" req -new -newkey rsa:2048 -keyout "${serverKey}" -out "${serverCsr}" ` +
  `-nodes -subj "/CN=P2P Radio/O=P2P Radio/C=CN"`, { stdio: 'inherit' });

// Sign with CA
execSync(`"${openssl}" x509 -req -in "${serverCsr}" -CA "${caCert}" -CAkey "${caKey}" ` +
  `-CAcreateserial -out "${serverCert}" -days 825 -extensions v3_ext -extfile "${extConf}"`, { stdio: 'inherit' });

// Cleanup
fs.unlinkSync(serverCsr);
fs.unlinkSync(extConf);

console.log('服务器证书已签发: cert.pem + key.pem');
console.log('');
console.log('现在运行 npm start，浏览器访问时不会再警告"不安全"。');
console.log(`SAN 覆盖的地址: ${sanEntries.join(', ')}`);
