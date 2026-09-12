import { panic } from "better-result";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const CERT_DIR = path.resolve(APP_ROOT, ".certs");
const CONFIG_PATH = path.resolve(CERT_DIR, "localhost-openssl.cnf");
const CERT_PATH = path.resolve(CERT_DIR, "localhost-cert.pem");
const KEY_PATH = path.resolve(CERT_DIR, "localhost-key.pem");

const OPENSSL_CONFIG = `
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = localhost

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
`.trimStart();

mkdirSync(CERT_DIR, { recursive: true });
writeFileSync(CONFIG_PATH, OPENSSL_CONFIG);

const proc = Bun.spawnSync([
  "openssl",
  "req",
  "-x509",
  "-nodes",
  "-days",
  "825",
  "-newkey",
  "rsa:2048",
  "-keyout",
  KEY_PATH,
  "-out",
  CERT_PATH,
  "-config",
  CONFIG_PATH,
]);

if (!proc.success) {
  const stderr = new TextDecoder().decode(proc.stderr);
  panic(`Failed to create localhost certificate: ${stderr}`);
}

console.log(`Created ${CERT_PATH}`);
console.log(`Created ${KEY_PATH}`);
console.log("");
console.log("To avoid Outlook/browser certificate warnings on macOS, run:");
console.log(
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CERT_PATH}`,
);
