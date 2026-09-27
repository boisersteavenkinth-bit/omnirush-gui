// Test-only TLS-intercepting proxy: the way antivirus HTTPS scanning or a
// corporate proxy sits in front of omnirush.ai. It terminates TLS for the
// given host names with a leaf issued by its own root CA (served together
// with that root, as those products do), and relays the bytes to the real
// server over a verified TLS connection.
//
// Point the host names at 127.0.0.1 (hosts file or container /etc/hosts),
// trust <dir>/root.pem in the throwaway system store, then run:
//   node intercept-proxy.mjs --dir <dir> [--port 443] [--hosts omnirush.ai,www.omnirush.ai]
//   node intercept-proxy.mjs --dir <dir> --certs-only
// The upstream address is resolved with DNS directly (dns.resolve4), so the
// hosts-file override does not loop back into the proxy.
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dir = path.resolve(arg("dir", "intercept-ca"));
const port = Number(arg("port", "443"));
const hosts = String(arg("hosts", "omnirush.ai")).split(",").map((host) => host.trim()).filter(Boolean);
const openssl = process.env.OPENSSL_BIN || "openssl";

function ensureCertificates() {
  mkdirSync(dir, { recursive: true });
  const root = path.join(dir, "root.pem");
  if (existsSync(root) && existsSync(path.join(dir, "chain.pem"))) return;
  const run = (...args) => execFileSync(openssl, args, { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "root.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
  run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.csr", "-subj", "/CN=OmniRush.ai Test Interception Root/O=Test Only");
  run("x509", "-req", "-in", "root.csr", "-signkey", "root.key", "-out", "root.pem", "-days", "3", "-sha256", "-extfile", "root.ext");
  writeFileSync(path.join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`);
  run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${hosts[0]}`);
  run("x509", "-req", "-in", "leaf.csr", "-CA", "root.pem", "-CAkey", "root.key", "-set_serial", String(Date.now()), "-out", "leaf.pem", "-days", "2", "-sha256", "-extfile", "leaf.ext");
  writeFileSync(path.join(dir, "chain.pem"), `${readFileSync(path.join(dir, "leaf.pem"), "utf8")}${readFileSync(root, "utf8")}`);
  // DER copy for Windows certutil / Import-Certificate.
  run("x509", "-in", "root.pem", "-outform", "DER", "-out", "root.cer");
}

ensureCertificates();
if (process.argv.includes("--certs-only")) {
  console.log(`[intercept] certificates in ${dir}`);
  process.exit(0);
}

const upstream = new Map();
for (const host of hosts) {
  const addresses = await dns.resolve4(host);
  upstream.set(host, addresses[0]);
}

let intercepted = 0;
const server = tls.createServer({
  key: readFileSync(path.join(dir, "leaf.key")),
  cert: readFileSync(path.join(dir, "chain.pem")),
}, (client) => {
  const servername = client.servername || hosts[0];
  const address = upstream.get(servername) ?? upstream.get(hosts[0]);
  intercepted += 1;
  const remote = tls.connect({ host: address, port: 443, servername, ALPNProtocols: ["http/1.1"] });
  remote.on("secureConnect", () => {
    client.pipe(remote);
    remote.pipe(client);
  });
  const close = () => { client.destroy(); remote.destroy(); };
  remote.on("error", (error) => { console.error(`[intercept] upstream ${servername}: ${error.message}`); close(); });
  client.on("error", close);
  client.on("close", () => remote.destroy());
  remote.on("close", () => client.destroy());
});
server.on("tlsClientError", (error) => console.error(`[intercept] client TLS: ${error.message}`));
server.listen(port, "127.0.0.1", () => {
  console.log(`[intercept] listening on 127.0.0.1:${port} for ${hosts.join(", ")} -> ${[...upstream.values()].join(", ")}`);
});
setInterval(() => {
  writeFileSync(path.join(dir, "intercepted.txt"), `${intercepted}\n`);
}, 1000).unref?.();
