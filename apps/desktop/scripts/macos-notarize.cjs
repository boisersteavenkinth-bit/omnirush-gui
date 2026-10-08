#!/usr/bin/env node
/**
 * Apple notarization helpers for the macOS release.
 *
 * `notarizeFile` submits without `--wait` and polls the submission itself, so a
 * dropped connection during Apple's (sometimes hour-long) review does not fail
 * the build the way `notarytool submit --wait` does.
 *
 * As a command it finishes the disk images after electron-builder:
 *
 *   node scripts/macos-notarize.cjs --dist <dir> --manifest <latest-mac.yml> --keychain <path>
 *
 * Each DMG in <dir> is signed with the Developer ID identity from <keychain>,
 * notarized and stapled. Stapling changes the file, so its .blockmap is rebuilt
 * and its sha512 and size in the update manifest are rewritten. The zip the
 * updater installs is not touched: the app inside it was stapled before it was
 * zipped.
 *
 * Credentials come from APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID and
 * APPLE_API_ISSUER.
 */
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

async function runWithRetry(command, args, attempts, baseDelayMs = 30_000) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status === 0) return;
    if (attempt >= attempts) {
      throw new Error(`${command} ${args.join(" ")} failed with status ${result.status} after ${attempts} attempts`);
    }
    const delayMs = baseDelayMs * attempt;
    console.warn(`[notarize] ${command} ${args[0]} failed with status ${result.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`);
    await sleep(delayMs);
  }
}

function notaryCredentials(env = process.env) {
  const missing = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`${missing.join(", ")} required to notarize the macOS build`);
  if (!existsSync(env.APPLE_API_KEY)) throw new Error("APPLE_API_KEY must be the path to the App Store Connect .p8 key");
  return { key: env.APPLE_API_KEY, keyId: env.APPLE_API_KEY_ID, issuer: env.APPLE_API_ISSUER };
}

function authArgs(credentials) {
  return ["--key", credentials.key, "--key-id", credentials.keyId, "--issuer", credentials.issuer];
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function notarizeFile(filePath, credentials = notaryCredentials(), {
  pollMs = 30_000,
  timeoutMs = 150 * 60_000,
  submitAttempts = 4,
} = {}) {
  const name = path.basename(filePath);
  let id = null;
  for (let attempt = 1; !id; attempt++) {
    const submit = capture("xcrun", ["notarytool", "submit", filePath, ...authArgs(credentials), "--output-format", "json"]);
    id = parseJson(submit.stdout)?.id ?? null;
    if (id) break;
    const detail = `${submit.stdout}${submit.stderr}`.trim();
    if (attempt >= submitAttempts) throw new Error(`notarytool submit ${name} failed: ${detail}`);
    console.warn(`[notarize] submit ${name} failed (attempt ${attempt}/${submitAttempts}): ${detail}`);
    await sleep(30_000 * attempt);
  }
  console.log(`[notarize] ${name}: submission ${id}`);

  const deadline = Date.now() + timeoutMs;
  let status = "In Progress";
  while (status === "In Progress") {
    if (Date.now() > deadline) throw new Error(`notarization of ${name} (${id}) did not finish within ${timeoutMs / 60_000} minutes`);
    await sleep(pollMs);
    const info = capture("xcrun", ["notarytool", "info", id, ...authArgs(credentials), "--output-format", "json"]);
    const parsed = parseJson(info.stdout);
    if (parsed?.status) {
      status = parsed.status;
    } else {
      // A network blip while polling is not a notarization failure.
      console.warn(`[notarize] ${name}: status check failed, retrying: ${`${info.stdout}${info.stderr}`.trim()}`);
    }
  }
  console.log(`[notarize] ${name}: ${status}`);

  let log = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = capture("xcrun", ["notarytool", "log", id, ...authArgs(credentials)]);
    if (result.status === 0) {
      log = result.stdout;
      break;
    }
    await sleep(15_000 * attempt);
  }
  if (log) console.log(`[notarize] ${name} log:\n${log}`);
  if (status !== "Accepted") throw new Error(`notarization of ${name} (${id}) ended with status ${status}`);
  return { id, status };
}

async function staple(filePath) {
  // A fresh ticket can take minutes to reach Apple's CDN; stapler then fails
  // with status 65 ("CloudKit query failed").
  await runWithRetry("xcrun", ["stapler", "staple", filePath], 5);
  run("xcrun", ["stapler", "validate", filePath]);
}

function developerIdIdentity(keychain) {
  const { stdout } = capture("security", ["find-identity", "-v", "-p", "codesigning", keychain]);
  const match = stdout.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: [^"]+"/m);
  if (!match) throw new Error(`no Developer ID Application identity in ${keychain}`);
  return match[1];
}

function sha512Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

async function rebuildBlockmap(filePath) {
  const builderDir = path.dirname(require.resolve("electron-builder/package.json"));
  const libDir = path.dirname(require.resolve("app-builder-lib/package.json", { paths: [builderDir] }));
  const { buildBlockMap } = require(path.join(libDir, "out", "targets", "blockmap", "blockmap.js"));
  await buildBlockMap(filePath, "gzip", `${filePath}.blockmap`);
}

/**
 * Points the manifest entries for the given files at their current bytes. Edits
 * the parsed document in place so every other value keeps its exact form (a
 * quoted releaseDate must stay a string for electron-updater's YAML parser).
 */
async function refreshManifest(manifestPath, filePaths) {
  const YAML = require("yaml");
  const doc = YAML.parseDocument(readFileSync(manifestPath, "utf8"));
  const files = doc.get("files");
  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    const entry = files?.items?.find((item) => item.get("url") === name);
    if (!entry) throw new Error(`${path.basename(manifestPath)} does not list ${name}`);
    const sha512 = await sha512Base64(filePath);
    entry.set("sha512", sha512);
    entry.set("size", statSync(filePath).size);
    if (doc.get("path") === name) doc.set("sha512", sha512);
  }
  writeFileSync(manifestPath, doc.toString({ lineWidth: 0 }));
}

async function finishDiskImages({ dist, manifest, keychain }) {
  const credentials = notaryCredentials();
  const identity = developerIdIdentity(keychain);
  const images = readdirSync(dist).filter((name) => name.endsWith(".dmg")).map((name) => path.join(dist, name));
  if (!images.length) throw new Error(`no .dmg in ${dist}`);
  for (const image of images) {
    run("codesign", ["--force", "--sign", identity, "--keychain", keychain, "--timestamp", image]);
    await notarizeFile(image, credentials);
    await staple(image);
    await rebuildBlockmap(image);
  }
  await refreshManifest(manifest, images);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag.startsWith("--") || argv[i + 1] === undefined) throw new Error(`unexpected argument ${flag}`);
    args[flag.slice(2)] = argv[i + 1];
  }
  for (const name of ["dist", "manifest", "keychain"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  return args;
}

module.exports = { notaryCredentials, notarizeFile, staple, runWithRetry, refreshManifest, rebuildBlockmap };

if (require.main === module) {
  finishDiskImages(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[notarize] ${error?.message ?? error}`);
    process.exit(1);
  });
}
