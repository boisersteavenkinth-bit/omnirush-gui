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
import { homedir, tmpdir } from "os";
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

// The engine is OmniRush.ai's build of opencode 1.18.32 (the one the CLI
// bundles), published as per-platform tarballs on a private GitHub release of
// the CLI repo and sha256-pinned in engine-release.json. Each tarball holds one
// executable, `opencode[.exe]`, at its root.
const engineReleasePath = resolve(__dirname, "engine-release.json");
const engineRelease = JSON.parse(readFileSync(engineReleasePath, "utf8"));

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
      // The engine prints the bare version ("1.18.32").
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

if (normalizedOpencodeVersion !== engineRelease.version) {
  console.error(
    `constants.json pins OpenCode ${normalizedOpencodeVersion}, but ${engineReleasePath} pins the engine release ${engineRelease.tag} (${engineRelease.version}).`
  );
  process.exit(1);
}

const engineAsset = resolvedTargetTriple ? engineRelease.assets?.[resolvedTargetTriple] ?? null : null;

/** What the sidecar directory holds: the engine release and archive it was taken from. */
const readRecordedEngine = () => {
  const names = [resolvedTargetTriple ? `versions.json-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}` : null, "versions.json"];
  for (const name of names.filter(Boolean)) {
    try {
      const parsed = JSON.parse(readFileSync(join(sidecarDir, name), "utf8"));
      if (parsed?.opencode) return parsed.opencode;
    } catch {
      // not recorded
    }
  }
  return null;
};

const recordedEngine = readRecordedEngine();
const shouldDownloadOpencode =
  !opencodeCandidatePath ||
  !existsSync(opencodeCandidatePath) ||
  isStubBinary(opencodeCandidatePath) ||
  !existingOpencodeVersion ||
  existingOpencodeVersion !== normalizedOpencodeVersion ||
  !engineAsset ||
  recordedEngine?.archiveSha256 !== engineAsset.sha256 ||
  (opencodeCandidatePath && recordedEngine?.sha256 !== sha256File(opencodeCandidatePath));

if (!shouldDownloadOpencode) {
  console.log(`OpenCode sidecar already present (${existingOpencodeVersion}, ${engineRelease.tag}).`);
}

/** A token that can read the private engine release (never printed). */
const githubToken = () => {
  for (const name of ["OMNIRUSH_ENGINE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return gh.status === 0 ? gh.stdout.trim() || null : null;
};

const githubApi = async (url, accept, token) => {
  const response = await fetch(url, {
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      "user-agent": "omnirush-desktop-prepare-sidecar",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return response;
};

/** The pinned archive's bytes: a local copy (OMNIRUSH_ENGINE_ARCHIVE), the cache, or the release. */
const readEngineArchive = async () => {
  const verify = (bytes, source) => {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== engineAsset.sha256) {
      throw new Error(`Checksum mismatch for ${engineAsset.name} from ${source}: expected ${engineAsset.sha256}, got ${actual}`);
    }
    return bytes;
  };
  const local = process.env.OMNIRUSH_ENGINE_ARCHIVE?.trim();
  if (local) return verify(readFileSync(resolve(local)), local);
  const cacheDir = process.env.OMNIRUSH_ENGINE_CACHE?.trim()
    ? resolve(process.env.OMNIRUSH_ENGINE_CACHE.trim())
    : join(homedir(), ".cache", "omnirush-desktop", "engine");
  const cached = join(cacheDir, engineRelease.tag, engineAsset.name);
  if (existsSync(cached)) {
    try {
      return verify(readFileSync(cached), cached);
    } catch (error) {
      console.warn(`${error instanceof Error ? error.message : String(error)}; downloading it again.`);
    }
  }
  const token = githubToken();
  if (!token) {
    throw new Error(
      `A GitHub token that can read ${engineRelease.repo} is required to fetch the engine from its private release ${engineRelease.tag}: ` +
        "set OMNIRUSH_ENGINE_TOKEN (or GH_TOKEN / GITHUB_TOKEN), sign in with `gh auth login`, or point OMNIRUSH_ENGINE_ARCHIVE at the archive.",
    );
  }
  const release = await (await githubApi(
    `https://api.github.com/repos/${engineRelease.repo}/releases/tags/${engineRelease.tag}`,
    "application/vnd.github+json",
    token,
  )).json();
  const asset = (release.assets ?? []).find((entry) => entry.name === engineAsset.name);
  if (!asset) throw new Error(`${engineAsset.name} is not an asset of ${engineRelease.repo} release ${engineRelease.tag}`);
  const bytes = verify(Buffer.from(await (await githubApi(asset.url, "application/octet-stream", token)).arrayBuffer()), asset.url);
  try {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, bytes);
  } catch {
    // the cache is optional
  }
  return bytes;
};

if (shouldDownloadOpencode) {
  if (!engineAsset) {
    console.error(`No engine archive is pinned for target ${resolvedTargetTriple ?? "unknown"} in ${engineReleasePath}.`);
    process.exit(1);
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const archivePath = join(tmpdir(), `opencode-${stamp}-${engineAsset.name}`);
  const extractDir = join(tmpdir(), `opencode-${stamp}`);
  mkdirSync(extractDir, { recursive: true });

  try {
    writeFileSync(archivePath, await readEngineArchive());
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
  try {
    unlinkSync(archivePath);
  } catch {
    // ignore
  }

  console.log(`OpenCode sidecar updated to ${normalizedOpencodeVersion} (${engineRelease.tag}).`);
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
    release: engineRelease.tag,
    archiveSha256: engineAsset?.sha256 ?? null,
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
