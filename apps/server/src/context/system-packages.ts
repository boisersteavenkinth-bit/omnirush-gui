// #5 System packages: the OS package manager's installed list, taken at most
// once a day per machine (cached in the app's state directory) and capped at
// 256 KiB. Linux: dpkg, rpm, apk or pacman (the first installed); macOS:
// Homebrew when it is installed (never a /usr/bin Command Line Tools shim);
// Windows: winget, non-interactive (a winget that would ask to accept its
// source agreements is skipped).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { runTool, type RunResult, type Runner } from "./exec.js";
import { capList } from "./privacy.js";

export const MAX_SYSTEM_PACKAGES_BYTES = 256 * 1024;
const LIST_TIMEOUT_MS = 30_000;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_FILE = "system-packages.json";

export type SystemPackageManager = "dpkg" | "rpm" | "apk" | "pacman" | "brew" | "winget";
export type SystemPackage = { name: string; version: string };
export type SystemPackages =
  | { manager: SystemPackageManager; collected_at: string; count: number; packages: SystemPackage[]; truncated: boolean }
  | { skipped: "not_found" | "would_prompt" | "timeout" | "failed" | "clt_shim" };

type Lister = { manager: SystemPackageManager; command: string; args: string[]; parse: (result: RunResult) => SystemPackage[] | null };

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** `name version` per line (dpkg-query format, pacman -Q, brew list --versions keeps every version). */
export function parseNameVersionLines(text: string): SystemPackage[] {
  const out: SystemPackage[] = [];
  for (const line of lines(text)) {
    const [name, ...rest] = line.split(/\s+/);
    if (name && rest.length > 0) out.push({ name, version: rest.join(" ") });
  }
  return out;
}

/** rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE}\n'. */
export const parseRpm = parseNameVersionLines;

/** apk info -v: `name-1.2.3-r0` per line (the version starts at the last-but-one dash group). */
export function parseApk(text: string): SystemPackage[] {
  const out: SystemPackage[] = [];
  for (const line of lines(text)) {
    const match = /^(.+?)-(\d[^-]*-r\d+)$/.exec(line);
    if (match) out.push({ name: match[1]!, version: match[2]! });
  }
  return out;
}

/**
 * winget list: a fixed-width table under a `Name  Id  Version  Available  Source`
 * header (localized headers are recognised by the dashed rule under them; the
 * Id column is used as the name since it is stable across languages).
 */
export function parseWinget(text: string): SystemPackage[] {
  const all = text.split(/\r?\n/).map((line) => line.replace(/^\s*[-\\|/]\s*$/, "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));
  const ruleIndex = all.findIndex((line) => /^-{10,}\s*$/.test(line.trim()));
  if (ruleIndex < 1) return [];
  const header = all[ruleIndex - 1]!;
  const starts: number[] = [];
  for (const match of header.matchAll(/\S+(?:\s\S+)*/g)) starts.push(match.index!);
  if (starts.length < 3) return [];
  const column = (line: string, index: number) => line.slice(starts[index], index + 1 < starts.length ? starts[index + 1] : undefined).trim();
  const out: SystemPackage[] = [];
  for (const line of all.slice(ruleIndex + 1)) {
    if (!line.trim()) continue;
    const id = column(line, 1);
    const version = column(line, 2);
    const name = id || column(line, 0);
    if (name && version) out.push({ name, version });
  }
  return out;
}

export function listersFor(platform: NodeJS.Platform): Lister[] {
  if (platform === "darwin") {
    return [{ manager: "brew", command: "brew", args: ["list", "--versions"], parse: (r) => (r.code === 0 ? parseNameVersionLines(r.stdout) : null) }];
  }
  if (platform === "win32") {
    return [{
      manager: "winget",
      command: "winget",
      args: ["list", "--accept-source-agreements", "--disable-interactivity"],
      parse: (r) => (r.code === 0 ? parseWinget(r.stdout) : null),
    }];
  }
  return [
    { manager: "dpkg", command: "dpkg-query", args: ["-W", "-f", "${Package} ${Version}\\n"], parse: (r) => (r.code === 0 ? parseNameVersionLines(r.stdout) : null) },
    { manager: "rpm", command: "rpm", args: ["-qa", "--queryformat", "%{NAME} %{VERSION}-%{RELEASE}\\n"], parse: (r) => (r.code === 0 ? parseRpm(r.stdout) : null) },
    { manager: "apk", command: "apk", args: ["info", "-v"], parse: (r) => (r.code === 0 ? parseApk(r.stdout) : null) },
    { manager: "pacman", command: "pacman", args: ["-Q"], parse: (r) => (r.code === 0 ? parseNameVersionLines(r.stdout) : null) },
  ];
}

/** Whether winget stopped to ask for something (source agreements, a store login) instead of listing. */
export function wingetWouldPrompt(result: RunResult): boolean {
  return result.code !== 0 && /agreement|accept|\[Y\]|\(Y\/N\)|press any key/i.test(`${result.stdout}\n${result.stderr}`);
}

export type SystemPackagesOptions = {
  platform?: NodeJS.Platform;
  run?: Runner;
  resolve?: (command: string) => string | null;
  /** Directory holding the once-a-day cache (the app's state directory); none: no cache. */
  cacheDir?: string | null;
  now?: () => Date;
  machine?: string;
};

type CacheFile = { machine: string; day: string; value: SystemPackages };

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function readCache(dir: string, machine: string, day: string): Promise<SystemPackages | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, CACHE_FILE), "utf8")) as CacheFile;
    if (parsed && parsed.machine === machine && parsed.day === day && parsed.value && typeof parsed.value === "object") return parsed.value;
  } catch {
    // No cache yet, or unreadable: list again.
  }
  return null;
}

async function writeCache(dir: string, entry: CacheFile): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, CACHE_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
    await rename(temp, target);
  } catch {
    // The list is taken again next session.
  }
}

/** Lists the installed system packages without any cache. */
export async function listSystemPackages(options: SystemPackagesOptions = {}): Promise<SystemPackages> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  for (const lister of listersFor(platform)) {
    const resolved = (options.resolve ?? undefined)?.(lister.command);
    const result = await runTool(lister.command, lister.args, {
      timeoutMs: LIST_TIMEOUT_MS,
      maxBytes: LIST_MAX_BYTES,
      ...(options.run ? { run: options.run } : {}),
      ...(options.resolve ? { resolve: () => resolved ?? null } : {}),
    });
    if (!result) continue;
    if (result.timedOut) return { skipped: "timeout" };
    if (lister.manager === "winget" && wingetWouldPrompt(result)) return { skipped: "would_prompt" };
    const packages = lister.parse(result);
    if (!packages) return { skipped: "failed" };
    packages.sort((left, right) => left.name.localeCompare(right.name));
    const capped = capList(packages, MAX_SYSTEM_PACKAGES_BYTES);
    return {
      manager: lister.manager,
      collected_at: now().toISOString(),
      count: packages.length,
      packages: capped.items,
      truncated: capped.truncated || result.truncated,
    };
  }
  return { skipped: "not_found" };
}

/** The installed system packages, from today's cache for this machine when there is one. */
export async function systemPackages(options: SystemPackagesOptions = {}): Promise<SystemPackages> {
  const now = options.now ?? (() => new Date());
  const machine = options.machine ?? `${safeHostname()}/${options.platform ?? process.platform}`;
  const day = localDay(now());
  if (options.cacheDir) {
    const cached = await readCache(options.cacheDir, machine, day);
    if (cached) return cached;
  }
  const value = await listSystemPackages(options);
  if (options.cacheDir && !("skipped" in value && value.skipped === "timeout")) await writeCache(options.cacheDir, { machine, day, value });
  return value;
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}
