// @ts-nocheck -- ported from the CLI suite; exercises loosely typed fakes.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as env from "./project-env.js";
import * as toolchain from "./toolchain.js";
import * as uploader from "./session-uploader.js";

const hasZstd = typeof zlib.zstdDecompressSync === "function";
const SECRETS = {
  apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  dbPassword: "hunter2",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  pem: "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
};
const DOTENV = [
  "# local settings",
  "NODE_ENV=development",
  "PORT=3000",
  "export DEBUG=true",
  `API_KEY=${SECRETS.apiKey}`,
  `DATABASE_URL=postgres://admin:${SECRETS.dbPassword}@db.example.com:5432/app`,
  "LOCAL_DB=postgres://localhost:5432/app",
  `REDIS_URL=redis://user:${SECRETS.dbPassword}@localhost:6379`,
  `AUTH=${SECRETS.jwt}`,
  `TOKENISH=${SECRETS.jwt}`,
  "SESSION_SECRET=true",
  'GREETING="hello world"',
  "LOG_LEVEL=info # verbose in CI",
  "MODE='production'",
  "TEAM_NAME=acme-internal",
  "HOME_DIR=/home/alice/app",
  `PRIVATE_PEM="-----BEGIN RSA PRIVATE KEY-----`,
  SECRETS.pem,
  `-----END RSA PRIVATE KEY-----"`,
  "AFTER_PEM=1",
  "",
].join("\n");

function tempDir(prefix = "omnirush-penv-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

const checks = {
  isSecretName: uploader.isSecretAssignmentKey,
  scrubText: (text) => uploader.redactUploadText(text).text,
  isDenied: uploader.isUploadPathDenied,
};

test(".env: names always, values only when clearly not secret", () => {
  const { keys } = env.parseEnvFile(DOTENV, checks);
  assert.deepEqual(keys, [
    { name: "NODE_ENV", value: "development" },
    { name: "PORT", value: "3000" },
    { name: "DEBUG", value: "true" },
    { name: "API_KEY" },
    { name: "DATABASE_URL" },
    { name: "LOCAL_DB", value: "postgres://localhost:5432/app" },
    { name: "REDIS_URL" },
    { name: "AUTH" },
    { name: "TOKENISH" },
    { name: "SESSION_SECRET" },
    { name: "GREETING" },
    { name: "LOG_LEVEL", value: "info" },
    { name: "MODE", value: "production" },
    { name: "TEAM_NAME" },
    { name: "HOME_DIR" },
    { name: "PRIVATE_PEM" },
    { name: "AFTER_PEM", value: "1" },
  ]);
  const flat = JSON.stringify(keys);
  for (const secret of [...Object.values(SECRETS), "admin", "alice", "acme", "BEGIN"]) assert.ok(!flat.includes(secret), `leaked ${secret}`);
});

test("safeEnvValue keeps booleans, ports, enum words and credential-free localhost URLs only", () => {
  const keep = (name, value) => env.safeEnvValue(name, value, checks);
  assert.equal(keep("FEATURE_X", "false"), "false");
  assert.equal(keep("WORKERS", "8"), "8");
  assert.equal(keep("APP_URL", "http://localhost:3000/api"), "http://localhost:3000/api");
  assert.equal(keep("APP_URL", "https://app.example.com"), undefined);
  assert.equal(keep("APP_URL", "http://u:p@localhost:3000"), undefined);
  assert.equal(keep("APP_URL", "http://localhost:3000/?token=abc"), undefined);
  assert.equal(keep("ACCOUNT_NUMBER", "123456"), undefined);
  assert.equal(keep("SECRET_PORT", "3000"), undefined);
  assert.equal(keep("PASSWORD", "true"), undefined);
  assert.equal(keep("SOMETHING", "hunter2"), undefined);
  assert.equal(keep("BIG", "12345678901234"), undefined);
  assert.equal(keep("REF", "${OTHER}"), undefined);
});

test(".env files are found in the root and subfolders; templates and dependency folders are not", async () => {
  const root = write(tempDir(), {
    ".env": "A=1\n",
    ".env.local": "B=true\n",
    ".env.example": "C=1\n",
    ".env.sample": "D=1\n",
    "services/api/.env.development": "NODE_ENV=development\n",
    "node_modules/pkg/.env": "E=1\n",
    "notenv.txt": "F=1\n",
  });
  const files = await env.collectEnvFiles(root, checks);
  assert.deepEqual(files.map((file) => file.path), [".env", ".env.local", "services/api/.env.development"]);
  assert.deepEqual(files[2].keys, [{ name: "NODE_ENV", value: "development" }]);
});

test("env var names read by the code, across languages, sorted and capped", async () => {
  const names = env.envNamesIn([
    "const a = process.env.STRIPE_KEY; const b = process.env['DB_HOST']; const c = import.meta.env.VITE_URL;",
    "Deno.env.get(\"DENO_X\"); Bun.env.BUN_X;",
    "os.environ['PY_A']; os.environ.get(\"PY_B\"); os.getenv('PY_C')",
    "std::env::var(\"RUST_X\"); env!(\"RUST_BUILD\"); option_env!(\"RUST_OPT\");",
    "os.Getenv(\"GO_Y\"); os.LookupEnv(\"GO_Z\")",
    "System.getenv(\"JAVA_HOME\"); ENV['RUBY_A']; ENV.fetch(\"RUBY_B\"); $_ENV['PHP_A']; getenv('PHP_B');",
    "Environment.GetEnvironmentVariable(\"DOTNET_X\")",
    "process.env.lower_ok; process.env[name]; os.environ[key]",
  ].join("\n"));
  assert.deepEqual([...names].sort(), [
    "BUN_X", "DB_HOST", "DENO_X", "DOTNET_X", "GO_Y", "GO_Z", "JAVA_HOME", "PHP_A", "PHP_B", "PY_A", "PY_B", "PY_C",
    "RUBY_A", "RUBY_B", "RUST_BUILD", "RUST_OPT", "RUST_X", "STRIPE_KEY", "VITE_URL", "lower_ok",
  ]);

  const root = write(tempDir(), {
    "src/app.ts": "process.env.APP_A; process.env.APP_B;",
    "src/many.js": Array.from({ length: 600 }, (_, i) => `process.env.N_${String(i).padStart(3, "0")};`).join("\n"),
    "node_modules/dep/index.js": "process.env.FROM_DEPENDENCY",
    ".env": "process.env.IN_DOTENV",
    "README.md": "process.env.IN_DOCS",
  });
  const read = await env.collectEnvNamesRead(root, checks);
  assert.equal(read.names.length, 500);
  assert.equal(read.truncated, true);
  assert.ok(read.names.includes("APP_A"));
  assert.ok(!read.names.includes("FROM_DEPENDENCY") && !read.names.includes("IN_DOTENV") && !read.names.includes("IN_DOCS"));
});

test("host: os-release, sw_vers, WSL and CPU", async () => {
  assert.deepEqual(env.parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'), {
    NAME: "Ubuntu", ID: "ubuntu", VERSION_ID: "24.04", PRETTY_NAME: "Ubuntu 24.04.1 LTS",
  });
  assert.deepEqual(env.parseSwVers("ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n"), { version: "15.1", build: "24B83" });
  assert.equal(env.isWsl("Linux version 5.15.153.1-microsoft-standard-WSL2", {}), true);
  assert.equal(env.isWsl("Linux version 6.8.0-139-generic", {}), false);
  assert.equal(env.isWsl("Linux version 6.8.0", { WSL_DISTRO_NAME: "Ubuntu" }), true);

  const mac = await env.systemInfo(async (file) => (file === "/usr/bin/sw_vers" ? "ProductVersion:\t14.6.1\nBuildVersion:\t23G93\n" : null), "darwin");
  assert.equal(mac.macos_version, "14.6.1");
  assert.equal(mac.macos_build, "23G93");
  assert.equal(mac.wsl, false);
  assert.ok(mac.cpu_logical_cores >= 1);
  assert.equal(typeof mac.cpu_model, "string");
  if (process.platform === "linux" && fs.existsSync("/etc/os-release")) {
    const linux = await env.systemInfo(async () => null, "linux");
    assert.equal(typeof linux.distro_id, "string");
  }
});

test("shell: name, version, version managers from env/PATH only, PATH without home or user name", async () => {
  assert.deepEqual(env.sanitizedPath("/home/alice/.nvm/versions/node/v22/bin:/usr/bin:/opt/alice-tools/bin:/home/alice", { home: "/home/alice", user: "alice", platform: "linux" }), [
    "~/.nvm/versions/node/v22/bin", "/usr/bin", "/opt/<user>-tools/bin", "~",
  ]);
  assert.deepEqual(env.sanitizedPath("C:\\Users\\Bob\\AppData\\Roaming\\npm;C:\\Windows\\system32;D:\\bob\\bin", { home: "C:\\Users\\Bob", user: "bob", platform: "win32" }), [
    "~\\AppData\\Roaming\\npm", "C:\\Windows\\system32", "D:\\<user>\\bin",
  ]);
  // A short user name is replaced only as a whole path component.
  assert.deepEqual(env.sanitizedPath("/opt/al/bin:/usr/local/bin", { home: "/home/al", user: "al", platform: "linux" }), ["/opt/<user>/bin", "/usr/local/bin"]);

  assert.deepEqual(env.versionManagers({ NVM_DIR: "x", PYENV_ROOT: "y" }, ["~/.asdf/shims"]), ["nvm", "pyenv", "asdf"]);
  const ran = [];
  const info = await env.shellInfo(async (file, args) => {
    ran.push(`${file} ${args.join(" ")}`);
    return "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\nCopyright\n";
  }, { env: { SHELL: "/bin/bash", PATH: `${os.homedir()}/.volta/bin:/usr/bin`, VOLTA_HOME: "x" }, platform: "linux" });
  assert.equal(info.name, "bash");
  assert.equal(info.version, "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)");
  assert.deepEqual(info.version_managers, ["volta"]);
  assert.deepEqual(info.path, ["~/.volta/bin", "/usr/bin"]);
  assert.deepEqual(ran, ["/bin/bash --version"], "only the shell itself runs, never a shim");
  const odd = await env.shellInfo(async () => assert.fail("no version probe for an unknown shell"), { env: { SHELL: "/usr/local/bin/mysh", PATH: "" }, platform: "linux" });
  assert.equal(odd.name, "mysh");
  assert.equal(odd.version, undefined);
});

test("maven, gradle and cmake versions; npm ls only with package.json and node_modules, reduced to versions", async () => {
  const gradleOut = "\n------------------------------------------------------------\nGradle 8.5\n------------------------------------------------------------\n\nBuild time: 2023\n";
  const npmTree = JSON.stringify({
    name: "demo",
    version: "1.0.0",
    dependencies: {
      react: { version: "18.3.1", resolved: "https://registry.npmjs.org/react/-/react-18.3.1.tgz" },
      local: { version: "file:../local", resolved: "file:/home/alice/local" },
      private: { version: "1.0.0", resolved: "git+https://alice:ghp_token@github.com/acme/private.git" },
      gone: { missing: true },
    },
  });
  const run = async (file, args) => {
    const name = path.basename(file);
    if (name === "mvn") return { code: 0, stdout: "Apache Maven 3.9.6 (bc0240f3c744dd6b6ec2920b3cd08dcc295161ae)\nMaven home: /home/alice/.sdkman/candidates/maven\n", stderr: "" };
    if (name === "gradle") return { code: 0, stdout: gradleOut, stderr: "" };
    if (name === "cmake") return { code: 0, stdout: "cmake version 3.28.3\n\nCMake suite maintained by Kitware\n", stderr: "" };
    if (name === "npm" && args[0] === "ls") return { code: 1, stdout: npmTree, stderr: "npm ERR! missing: gone" };
    return null;
  };
  const resolve = (command) => (["mvn", "gradle", "cmake", "npm"].includes(command) ? `/opt/bin/${command}` : null);
  const root = write(tempDir(), { "package.json": "{}", "node_modules/react/package.json": "{}" });
  const result = await toolchain.collectToolchain(root, { env: {}, resolve, run });
  assert.equal(result.versions.mvn, "Apache Maven 3.9.6 (bc0240f3c744dd6b6ec2920b3cd08dcc295161ae)");
  assert.equal(result.versions.gradle, "Gradle 8.5");
  assert.equal(result.versions.cmake, "cmake version 3.28.3");
  assert.deepEqual(result.npm_ls, { name: "demo", version: "1.0.0", dependencies: { react: "18.3.1", local: "local", private: "1.0.0", gone: "missing" } });
  assert.ok(!JSON.stringify(result.npm_ls).match(/alice|ghp_|registry|github/));

  const withoutModules = await toolchain.collectToolchain(write(tempDir(), { "package.json": "{}" }), { env: {}, resolve, run });
  assert.equal(withoutModules.npm_ls, undefined);
  const big = toolchain.summarizeNpmLs(JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`package-number-${i}`, { version: "1.2.3" }])) }));
  assert.equal(big.truncated, true);
  assert.ok(JSON.stringify(big).length <= 64 * 1024);
});

test.skipIf(!hasZstd || process.platform === "win32")("the upload envelope carries env names, host and shell detail, and never a secret value", async () => {
  const root = write(tempDir(), {
    ".env": DOTENV,
    "config/.env.production": `STRIPE_SECRET_KEY=${SECRETS.apiKey}\nNODE_ENV=production\n`,
    "src/server.js": "const k = process.env.STRIPE_SECRET_KEY; const p = process.env.PORT;",
    "package.json": "{}",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  const stateDir = tempDir("omnirush-penv-state-");
  const envelopes = [];
  const workspaceSync = new uploader.SessionUploader({
    stateDir,
    fallbackScanMs: 60_000,
    capabilities: async () => ({ schema_versions: [2], canonical_trace: false }),
    toolchain: { waitMs: 10_000, resolve: () => null, env: { SHELL: "/bin/sh", PATH: `${os.homedir()}/bin:/usr/bin` } },
    upload: async (_sessionId, compressed) => {
      envelopes.push(zlib.zstdDecompressSync(Buffer.from(compressed)).toString("utf8"));
      return new Response("{}", { status: 201 });
    },
  });
  const sessionId = "01a0dcd2-d8ee-7222-80eb-240063770432";
  workspaceSync.startSession(sessionId, "ws", root);
  await workspaceSync.idle(sessionId);
  await workspaceSync.stop();
  assert.ok(envelopes.length >= 1);
  const toolchainBlock = JSON.parse(envelopes.at(-1)).environment.toolchain;
  assert.deepEqual(toolchainBlock.env_files.map((file) => file.path), [".env", "config/.env.production"]);
  assert.deepEqual(toolchainBlock.env_files[1].keys, [{ name: "STRIPE_SECRET_KEY" }, { name: "NODE_ENV", value: "production" }]);
  assert.deepEqual(toolchainBlock.env_names_read, ["PORT", "STRIPE_SECRET_KEY"]);
  assert.deepEqual(toolchainBlock.shell.path, ["~/bin", "/usr/bin"]);
  assert.equal(toolchainBlock.system.wsl, false);
  for (const text of envelopes) {
    for (const secret of Object.values(SECRETS)) assert.ok(!text.includes(secret), `an envelope leaked ${secret.slice(0, 12)}…`);
    assert.ok(!text.includes(os.userInfo().username) || os.userInfo().username.length < 3 || !text.includes(`/${os.userInfo().username}/`));
  }
});
