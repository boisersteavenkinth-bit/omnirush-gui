import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const sidecarOverride = process.env.OMNIRUSH_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "resources", "sidecars");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");

const opencodeGithubRepo = (() => {
  const raw =
    process.env.OPENCODE_GITHUB_REPO?.trim() ||
    process.env.OMNIRUSH_OPENCODE_GITHUB_REPO?.trim() ||
    "anomalyco/opencode";
  const normalized = raw
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return "anomalyco/opencode";
  }
  return normalized;
})();
const opencodeVersion = (() => {
  try {
    const raw = readFileSync(constantsPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.opencodeVersion === "string" ? parsed.opencodeVersion.trim() || null : null;
  } catch {
    return null;
  }
})();

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

const opencodeAssetOverride = process.env.OPENCODE_ASSET?.trim() || null;

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
})();
const isWindowsTarget = process.platform === "win32" || resolvedTargetTriple?.includes("windows") === true;

const opencodeBaseName = isWindowsTarget ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);
const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`
  : null;
const opencodeTargetPath = opencodeTargetName ? join(sidecarDir, opencodeTargetName) : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;
let existingOpencodeVersion = null;

// omnirush-server paths
const omnirushServerDir = resolve(__dirname, "..", "..", "server");

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const findOpencodeBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${opencodeBaseName}`) || file.endsWith(`\\${opencodeBaseName}`)) ??
    candidates.find((file) => file.endsWith("/opencode.exe") || file.endsWith("\\opencode.exe")) ??
    candidates.find((file) => file.endsWith("/opencode") || file.endsWith("\\opencode")) ??
    null
  );
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) {
      // 2.x prints "opencode v2.0.18"; 1.x printed the bare version.
      const match = result.stdout.trim().match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/);
      return match ? match[1] : result.stdout.trim();
    }
  } catch {
    // ignore
  }
  return null;
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath)) return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare runnable macOS sidecars");
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(`Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`);
  }
};

const adHocSignDarwinSidecars = (paths) => {
  if (process.platform !== "darwin") return;
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    adHocSignDarwin(filePath);
  }
};

// omnirush-server is no longer compiled as a sidecar binary — it runs
// in-process inside Electron via a direct import of the server library.
// Server binary copy/sign skipped — runs in-process.

if (!existingOpencodeVersion && opencodeCandidatePath) {
  existingOpencodeVersion =
    existsSync(opencodeCandidatePath) && !isStubBinary(opencodeCandidatePath)
      ? readBinaryVersion(opencodeCandidatePath)
      : null;
}

const normalizedOpencodeVersion = normalizeVersion(opencodeVersion);

if (!normalizedOpencodeVersion) {
  console.error(
    `OpenCode version could not be resolved from ${constantsPath}.`
  );
  process.exit(1);
}

// The 2.x engine ships no GitHub release assets: each platform binary is an
// npm package (@opencode/cli-<platform>), a tarball holding package/bin/opencode.
// Its sha512 is checked against the registry's dist.integrity before use.
const opencodePackageByTarget = {
  "aarch64-apple-darwin": "cli-darwin-arm64",
  "x86_64-apple-darwin": "cli-darwin-x64-baseline",
  "x86_64-unknown-linux-gnu": "cli-linux-x64-baseline",
  "aarch64-unknown-linux-gnu": "cli-linux-arm64",
  "x86_64-pc-windows-msvc": "cli-windows-x64-baseline",
  "aarch64-pc-windows-msvc": "cli-windows-arm64",
};

const opencodeRegistry = (process.env.OPENCODE_NPM_REGISTRY?.trim() || "https://registry.npmjs.org").replace(/\/+$/, "");
const opencodePackage =
  opencodeAssetOverride ?? (resolvedTargetTriple ? opencodePackageByTarget[resolvedTargetTriple] : null);
const opencodeAsset = opencodePackage ? `${opencodePackage}-${normalizedOpencodeVersion}.tgz` : null;
const opencodeUrl = opencodePackage
  ? `${opencodeRegistry}/@opencode/${opencodePackage}/-/${opencodeAsset}`
  : null;

const shouldDownloadOpencode =
  !opencodeCandidatePath ||
  !existsSync(opencodeCandidatePath) ||
  isStubBinary(opencodeCandidatePath) ||
  !existingOpencodeVersion ||
  existingOpencodeVersion !== normalizedOpencodeVersion;

if (!shouldDownloadOpencode) {
  console.log(`OpenCode sidecar already present (${existingOpencodeVersion}).`);
}

/** The registry's dist.integrity of the platform package (sha512-<base64>). */
const readOpencodeIntegrity = async () => {
  const response = await fetch(`${opencodeRegistry}/@opencode/${opencodePackage}/${normalizedOpencodeVersion}`);
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for @opencode/${opencodePackage}@${normalizedOpencodeVersion}`);
  const meta = await response.json();
  const integrity = String(meta?.dist?.integrity ?? "");
  if (!integrity.startsWith("sha512-")) throw new Error(`No sha512 integrity for @opencode/${opencodePackage}@${normalizedOpencodeVersion}`);
  return integrity;
};

if (shouldDownloadOpencode) {
  if (!opencodePackage || !opencodeUrl) {
    console.error(
      `No OpenCode package configured for target ${resolvedTargetTriple ?? "unknown"}. Set OPENCODE_ASSET to override.`
    );
    process.exit(1);
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const archivePath = join(tmpdir(), `opencode-${stamp}-${opencodeAsset}`);
  const extractDir = join(tmpdir(), `opencode-${stamp}`);
  mkdirSync(extractDir, { recursive: true });

  try {
    const integrity = await readOpencodeIntegrity();
    const response = await fetch(opencodeUrl);
    if (!response.ok) throw new Error(`Download of ${opencodeUrl} failed: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const actual = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (actual !== integrity) throw new Error(`Integrity mismatch for ${opencodeUrl}: expected ${integrity}, got ${actual}`);
    writeFileSync(archivePath, archive);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // bsdtar (Windows 10+ tar.exe) and GNU tar both read gzip tarballs. Paths
  // are relative to the temp dir: Git Bash's GNU tar on Windows reads
  // "C:\..." as a remote host ("Cannot connect to C: resolve failed").
  const tarResult = spawnSync(
    "tar",
    ["-xzf", basename(archivePath), "-C", basename(extractDir)],
    { stdio: "inherit", cwd: tmpdir() },
  );
  if (tarResult.status !== 0) {
    process.exit(tarResult.status ?? 1);
  }

  const extractedBinary = findOpencodeBinary(extractDir);
  if (!extractedBinary) {
    console.error("OpenCode binary not found after extraction.");
    process.exit(1);
  }

  const opencodeTargets = [opencodeTargetPath, opencodePath].filter(Boolean);
  for (const target of opencodeTargets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target);
      }
    } catch {
      // ignore
    }
    copyFileSync(extractedBinary, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore
    }
  }

  console.log(`OpenCode sidecar updated to ${normalizedOpencodeVersion}.`);
}

adHocSignDarwinSidecars([
  opencodePath,
  opencodeTargetPath,
  // omnirush-server runs in-process — no binary to sign.
]);

const omnirushServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(omnirushServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  opencode: {
    version: normalizedOpencodeVersion,
    sha256: opencodeCandidatePath && existsSync(opencodeCandidatePath) ? sha256File(opencodeCandidatePath) : null,
  },
  "omnirush-server": {
    version: omnirushServerVersion,
    sha256: "in-process",
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = isWindowsTarget ? ".exe" : "";
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}${targetSuffix}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
