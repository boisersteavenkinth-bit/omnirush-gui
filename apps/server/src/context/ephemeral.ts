// #22 On-the-fly tools (npx, pnpm dlx, yarn dlx, bunx, uvx, pipx run,
// go run pkg@version, deno run npm:/jsr:): the package and the exact
// version that ran. An exact requested version is taken as is; otherwise
// the version is read from the runner's cache after the call (the npx
// cache, pnpm's dlx cache, bun's install cache, uv's cache and tool
// environments, pipx's run cache, the go module cache, deno's npm cache).
// Only when no cache has it, `npm view <pkg> version` is asked once for an
// npm package (marked `registry_latest`); anything else stays unresolved.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { runTool, type Runner } from "./exec.js";

export type EphemeralTool = {
  tool_call_id: string | null;
  runner: string;
  package: string;
  requested: string | null;
  version: string | null;
  resolved: "exact" | "cache" | "registry_latest" | "unresolved";
  source: "npx_cache" | "pnpm_cache" | "bun_cache" | "uv_cache" | "pipx_venv" | "go_modcache" | "deno_cache" | "registry" | null;
};

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const PY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SCAN_DIRS = 2_000;

export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "_");
}

/** The ecosystem of a runner. */
export function ecosystemOf(runner: string): "npm" | "pypi" | "go" | "deno" {
  if (runner === "uvx" || runner === "pipx run" || runner === "uv tool" || runner === "pipx") return "pypi";
  if (runner === "go run") return "go";
  if (runner === "deno run") return "deno";
  return "npm";
}

async function newestFirst(dirs: string[]): Promise<string[]> {
  const stamped = await Promise.all(dirs.map(async (dir) => ({ dir, at: await stat(dir).then((s) => s.mtimeMs, () => 0) })));
  return stamped.sort((a, b) => b.at - a.at).map((entry) => entry.dir);
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).slice(0, MAX_SCAN_DIRS).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function packageVersion(manifest: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export type CacheDirs = {
  home: string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
};

function npmCache({ home, platform, env }: CacheDirs): string | null {
  if (env.npm_config_cache) return env.npm_config_cache;
  if (platform === "win32") return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "npm-cache") : null;
  return home ? join(home, ".npm") : null;
}

function cacheHome({ home, platform, env }: CacheDirs): string | null {
  if (env.XDG_CACHE_HOME) return env.XDG_CACHE_HOME;
  if (platform === "darwin") return home ? join(home, "Library", "Caches") : null;
  if (platform === "win32") return env.LOCALAPPDATA ?? null;
  return home ? join(home, ".cache") : null;
}

/** The newest npx cache entry holding `pkg` (~/.npm/_npx/<hash>/node_modules/<pkg>/package.json). */
export async function npxCacheVersion(pkg: string, dirs: CacheDirs, wanted: string | null = null): Promise<string | null> {
  const cache = npmCache(dirs);
  if (!cache) return null;
  for (const entry of await newestFirst(await listDirs(join(cache, "_npx")))) {
    const version = await packageVersion(join(entry, "node_modules", pkg, "package.json"));
    if (version && (!wanted || version === wanted || !EXACT.test(wanted))) return version;
  }
  return null;
}

/** pnpm dlx: <cache>/pnpm/dlx/<hash>/<stamp>/node_modules/<pkg>/package.json (and the older flat layout). */
export async function pnpmDlxVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const bases = [cacheHome(dirs) ? join(cacheHome(dirs)!, "pnpm", "dlx") : null, dirs.platform === "win32" && dirs.env.LOCALAPPDATA ? join(dirs.env.LOCALAPPDATA, "pnpm-cache", "dlx") : null].filter(Boolean) as string[];
  for (const base of bases) {
    for (const hash of await newestFirst(await listDirs(base))) {
      const direct = await packageVersion(join(hash, "node_modules", pkg, "package.json"));
      if (direct) return direct;
      for (const stamp of await newestFirst(await listDirs(hash))) {
        const version = await packageVersion(join(stamp, "node_modules", pkg, "package.json"));
        if (version) return version;
      }
    }
  }
  return null;
}

/** bunx: ~/.bun/install/cache/<pkg>@<version>@@@1 folders. */
export async function bunCacheVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const base = dirs.env.BUN_INSTALL_CACHE_DIR ?? (dirs.home ? join(dirs.home, ".bun", "install", "cache") : null);
  if (!base) return null;
  const scoped = pkg.startsWith("@") ? pkg.split("/") : null;
  const dir = scoped ? join(base, scoped[0]!) : base;
  const prefix = `${scoped ? scoped[1] : pkg}@`;
  const candidates = (await listDirs(dir)).filter((path) => path.split(/[\\/]/).at(-1)!.startsWith(prefix));
  for (const entry of await newestFirst(candidates)) {
    const match = /@(\d[^@]*)@@@/.exec(entry.split(/[\\/]/).at(-1)!);
    if (match) return match[1]!;
  }
  return null;
}

/** A `<name>-<version>.dist-info` folder for the package, searched breadth-first under `base` (bounded). */
async function distInfoVersion(base: string, pkg: string, maxDepth: number): Promise<string | null> {
  const wanted = normalizePyName(pkg);
  let level = [base];
  let visited = 0;
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    const found: string[] = [];
    for (const dir of level) {
      if (visited++ > MAX_SCAN_DIRS) return null;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = /^(.+)-([^-]+)\.dist-info$/.exec(entry.name);
        if (match && normalizePyName(match[1]!) === wanted) found.push(join(dir, entry.name));
        else if (!entry.name.endsWith(".dist-info") && entry.name !== "__pycache__") next.push(join(dir, entry.name));
      }
    }
    if (found.length > 0) {
      const newest = (await newestFirst(found))[0]!;
      return /-([^-]+)\.dist-info$/.exec(newest)![1]!;
    }
    level = next;
  }
  return null;
}

/** uvx: uv's tool environments, then its archive cache. */
export async function uvVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const data = dirs.env.UV_TOOL_DIR ?? (dirs.platform === "win32" ? (dirs.env.APPDATA ? join(dirs.env.APPDATA, "uv", "tools") : null) : dirs.home ? join(dirs.env.XDG_DATA_HOME ?? join(dirs.home, ".local", "share"), "uv", "tools") : null);
  if (data) {
    const version = await distInfoVersion(join(data, pkg), pkg, 5);
    if (version) return version;
  }
  const cache = dirs.env.UV_CACHE_DIR ?? (dirs.platform === "win32" ? (dirs.env.LOCALAPPDATA ? join(dirs.env.LOCALAPPDATA, "uv", "cache") : null) : dirs.home ? join(dirs.env.XDG_CACHE_HOME ?? join(dirs.home, ".cache"), "uv") : null);
  if (!cache) return null;
  // archive-v0/<hash>/lib/python3.x/site-packages/<pkg>-<v>.dist-info (Windows: Lib/site-packages).
  for (const archive of (await listDirs(cache)).filter((dir) => /archive-v\d+$/.test(dir))) {
    for (const entry of (await newestFirst(await listDirs(archive))).slice(0, 200)) {
      const version = await distInfoVersion(entry, pkg, 4);
      if (version) return version;
    }
  }
  return null;
}

/** pipx run: <pipx home>/.cache/<hash>/ venvs. */
export async function pipxVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const homes = [dirs.env.PIPX_HOME, dirs.home ? join(dirs.home, ".local", "pipx") : null, dirs.home ? join(dirs.env.XDG_DATA_HOME ?? join(dirs.home, ".local", "share"), "pipx") : null].filter(Boolean) as string[];
  for (const home of homes) {
    for (const venv of await newestFirst(await listDirs(join(home, ".cache")))) {
      const version = await distInfoVersion(venv, pkg, 5);
      if (version) return version;
    }
    const installed = await distInfoVersion(join(home, "venvs", pkg), pkg, 5);
    if (installed) return installed;
  }
  return null;
}

/** go run pkg@latest: the newest version the module cache downloaded for the module or one of its parents. */
export async function goModVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const modcache = dirs.env.GOMODCACHE ?? (dirs.env.GOPATH ? join(dirs.env.GOPATH.split(dirs.platform === "win32" ? ";" : ":")[0]!, "pkg", "mod") : dirs.home ? join(dirs.home, "go", "pkg", "mod") : null);
  if (!modcache) return null;
  const parts = pkg.split("/");
  for (let n = parts.length; n >= 2; n -= 1) {
    // Upper-case letters are escaped as !lower in the module cache.
    const module = parts.slice(0, n).join("/").replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
    const dir = join(modcache, "cache", "download", ...module.split("/"), "@v");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".info"));
    } catch {
      continue;
    }
    const newest = await newestFirst(names.map((name) => join(dir, name)));
    if (newest[0]) return newest[0].split(/[\\/]/).at(-1)!.replace(/\.info$/, "");
  }
  return null;
}

/** deno run npm:pkg: <DENO_DIR>/npm/registry.npmjs.org/<pkg>/<version>. */
export async function denoNpmVersion(pkg: string, dirs: CacheDirs): Promise<string | null> {
  const denoDir = dirs.env.DENO_DIR ?? (cacheHome(dirs) ? join(cacheHome(dirs)!, "deno") : null);
  if (!denoDir || pkg.startsWith("jsr:")) return null;
  const newest = await newestFirst(await listDirs(join(denoDir, "npm", "registry.npmjs.org", ...pkg.split("/"))));
  return newest[0] ? newest[0].split(/[\\/]/).at(-1)! : null;
}

export type ResolveEphemeralOptions = Partial<CacheDirs> & { run?: Runner; resolve?: (command: string) => string | null; registryFallback?: boolean };

/** The exact version of one on-the-fly tool run (see the module comment). */
export async function resolveEphemeral(
  call: { tool_call_id: string | null; runner: string; package: string; requested: string | null },
  options: ResolveEphemeralOptions = {},
): Promise<EphemeralTool> {
  const dirs: CacheDirs = { home: options.home ?? null, platform: options.platform ?? process.platform, env: options.env ?? process.env };
  const base = { tool_call_id: call.tool_call_id, runner: call.runner, package: call.package, requested: call.requested };
  const ecosystem = ecosystemOf(call.runner);
  const validName = ecosystem === "pypi" ? PY_NAME.test(call.package) : ecosystem === "go" ? /^[\w.~/-]+$/.test(call.package) : NPM_NAME.test(call.package.replace(/^jsr:/, ""));
  if (!validName) return { ...base, version: null, resolved: "unresolved", source: null };
  if (call.requested && EXACT.test(call.requested)) return { ...base, version: call.requested.replace(/^v(?=\d)/, ecosystem === "go" ? "v" : ""), resolved: "exact", source: null };
  let version: string | null = null;
  let source: EphemeralTool["source"] = null;
  const attempt = async (value: Promise<string | null>, from: NonNullable<EphemeralTool["source"]>) => {
    if (version) return;
    version = await value.catch(() => null);
    if (version) source = from;
  };
  if (ecosystem === "npm") {
    if (call.runner === "pnpm dlx") await attempt(pnpmDlxVersion(call.package, dirs), "pnpm_cache");
    if (call.runner === "bunx" || call.runner === "bun x") await attempt(bunCacheVersion(call.package, dirs), "bun_cache");
    await attempt(npxCacheVersion(call.package, dirs, call.requested), "npx_cache");
  } else if (ecosystem === "pypi") {
    if (call.runner === "pipx run") await attempt(pipxVersion(call.package, dirs), "pipx_venv");
    await attempt(uvVersion(call.package, dirs), "uv_cache");
  } else if (ecosystem === "go") {
    await attempt(goModVersion(call.package, dirs), "go_modcache");
  } else {
    await attempt(denoNpmVersion(call.package, dirs), "deno_cache");
  }
  if (version) return { ...base, version, resolved: "cache", source };
  const npmName = ecosystem === "npm" ? call.package : ecosystem === "deno" && !call.package.startsWith("jsr:") ? call.package : null;
  if (npmName && options.registryFallback !== false) {
    const spec = call.requested && !EXACT.test(call.requested) && /^[\w.^~<>=*|-]+$/.test(call.requested) ? `${npmName}@${call.requested}` : npmName;
    const result = await runTool("npm", ["view", spec, "version"], {
      timeoutMs: 8_000,
      maxBytes: 64 * 1024,
      ...(options.run ? { run: options.run } : {}),
      ...(options.resolve ? { resolve: options.resolve } : {}),
    });
    const lines = result && result.code === 0 ? result.stdout.trim().split(/\r?\n/) : [];
    // A range lists `pkg@1.2.3 '1.2.3'` per match: the last one is the highest.
    const last = lines.at(-1)?.replace(/^.*\s'?|'$/g, "").trim() ?? "";
    if (EXACT.test(last)) return { ...base, version: last, resolved: "registry_latest", source: "registry" };
  }
  return { ...base, version: null, resolved: "unresolved", source: null };
}
