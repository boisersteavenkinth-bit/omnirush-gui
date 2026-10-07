/**
 * Files used (backend spec 19.7): the resolved dependency versions of
 * every subproject, read from its lockfile (no package manager is run).
 * State documents carry them as `dependencies`:
 *
 *   [{ dir, ecosystem, manifests, lockfile, resolved: { name: version }, count, truncated }]
 *
 * `dir` is the subproject folder (workspace-relative, `.` for the root),
 * `lockfile` the lockfile the versions come from, `manifests` the manifest
 * files beside it. The dependency folders themselves (node_modules, .venv,
 * vendor) are never archived; a replay rebuilds them from the archived
 * lockfile at these versions.
 *
 * Pure parsing; the caller reads the files (bounded by MAX_LOCKFILE_BYTES).
 * Identical in the CLI and the desktop app.
 */

export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
export const MAX_RESOLVED_PER_PROJECT = 5_000;
export const MAX_TOOLCHAIN_PROJECTS = 50;

export type Ecosystem = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "uv" | "pipenv" | "pdm" | "cargo" | "go" | "composer" | "bundler" | "gradle" | "maven" | "deno" | "other";

export type ToolchainProject = {
  dir: string;
  ecosystem: Ecosystem;
  lockfile: string;
  manifests: string[];
  resolved: Record<string, string>;
  count: number;
  truncated: boolean;
};

/** Lockfile name -> ecosystem (the names touched.ts findLockfiles finds, plus the pinned requirements files). */
export const LOCKFILE_ECOSYSTEMS: Record<string, Ecosystem> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "poetry.lock": "poetry",
  "uv.lock": "uv",
  "Pipfile.lock": "pipenv",
  "pdm.lock": "pdm",
  "Cargo.lock": "cargo",
  "go.sum": "go",
  "composer.lock": "composer",
  "Gemfile.lock": "bundler",
  "gradle.lockfile": "gradle",
  "deno.lock": "deno",
  "requirements.txt": "pip",
  "requirements.lock": "pip",
  "requirements-dev.txt": "pip",
};

/** Manifests looked for beside a lockfile. */
export const MANIFEST_NAMES = [
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "Cargo.toml", "go.mod", "composer.json",
  "Gemfile", "build.gradle", "build.gradle.kts", "settings.gradle", "pom.xml", "deno.json",
];

function put(out: Map<string, string>, name: string, version: string): void {
  const n = name.trim();
  const v = version.trim();
  if (!n || !v || n.length > 214 || v.length > 128) return;
  if (!out.has(n)) out.set(n, v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function npmLock(text: string, out: Map<string, string>): void {
  const doc = parseJson(text);
  if (!isRecord(doc)) return;
  if (isRecord(doc.packages)) {
    for (const [key, value] of Object.entries(doc.packages)) {
      if (!key || !isRecord(value) || typeof value.version !== "string") continue;
      const at = key.lastIndexOf("node_modules/");
      if (at === -1) continue;
      put(out, key.slice(at + "node_modules/".length), value.version);
    }
    return;
  }
  const walk = (deps: unknown): void => {
    if (!isRecord(deps)) return;
    for (const [name, value] of Object.entries(deps)) {
      if (!isRecord(value)) continue;
      if (typeof value.version === "string") put(out, name, value.version);
      walk(value.dependencies);
    }
  };
  walk(doc.dependencies);
}

function pnpmLock(text: string, out: Map<string, string>): void {
  // v5/v6: `  /name@1.2.3:` or `  /name/1.2.3:`; v9: `  name@1.2.3:` / `  '@scope/name@1.2.3(peer@x)':`.
  let section = "";
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) section = line.replace(/:.*$/, "");
    if (section !== "packages" && section !== "snapshots") continue;
    const match = /^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)[@/]([0-9][^(:'"\s]*)/.exec(line);
    if (match) put(out, match[1]!, match[2]!);
  }
}

function yarnLock(text: string, out: Map<string, string>): void {
  let names: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\S/.test(line) && line.trimEnd().endsWith(":")) {
      names = line.slice(0, -1).split(",").map((spec) => spec.trim().replace(/^"|"$/g, "")).map((spec) => {
        const at = spec.lastIndexOf("@");
        return at > 0 ? spec.slice(0, at) : spec;
      }).filter(Boolean);
      continue;
    }
    const version = /^ {2}version:?\s+"?([^"\s]+)"?/.exec(line);
    if (version && names.length) {
      for (const name of names) put(out, name, version[1]!);
      names = [];
    }
  }
}

function bunLock(text: string, out: Map<string, string>): void {
  // `"name": ["name@1.2.3", ...]` in the "packages" object (JSONC).
  const re = /"([^"]+)":\s*\[\s*"((?:@[^@"]+\/)?[^@"]+)@([^"]+)"/g;
  for (let match = re.exec(text); match; match = re.exec(text)) put(out, match[2]!, match[3]!.replace(/^npm:/, ""));
}

/** TOML `[[package]]` tables with `name` and `version` (Cargo.lock, poetry.lock, uv.lock, pdm.lock). */
function tomlPackages(text: string, out: Map<string, string>): void {
  let name: string | null = null;
  let version: string | null = null;
  let inPackage = false;
  const flush = () => {
    if (inPackage && name && version) put(out, name, version);
    name = null;
    version = null;
  };
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) {
      if (/^\s*\[\[package\]\]\s*$/.test(line)) {
        flush();
        inPackage = true;
      } else if (/^\s*\[\[?[^\]]*\]\]?\s*$/.test(line) && !/^\s*\[package\./.test(line)) {
        flush();
        inPackage = false;
      }
      continue;
    }
    if (!inPackage) continue;
    const n = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (n && name === null) name = n[1]!;
    const v = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (v && version === null) version = v[1]!;
  }
  flush();
}

function pipfileLock(text: string, out: Map<string, string>): void {
  const doc = parseJson(text);
  if (!isRecord(doc)) return;
  for (const group of ["default", "develop"]) {
    const deps = doc[group];
    if (!isRecord(deps)) continue;
    for (const [name, value] of Object.entries(deps)) if (isRecord(value) && typeof value.version === "string") put(out, name, value.version.replace(/^==/, ""));
  }
}

function requirements(text: string, out: Map<string, string>): void {
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;#\\]+)/.exec(line);
    if (match) put(out, match[1]!, match[2]!);
  }
}

function goSum(text: string, out: Map<string, string>): void {
  for (const line of text.split("\n")) {
    const match = /^(\S+)\s+(v[^\s/]+)(\/go\.mod)?\s+h1:/.exec(line);
    if (match && !match[3]) put(out, match[1]!, match[2]!);
  }
  if (out.size === 0) {
    for (const line of text.split("\n")) {
      const match = /^(\S+)\s+(v[^\s/]+)\/go\.mod\s+h1:/.exec(line);
      if (match) put(out, match[1]!, match[2]!);
    }
  }
}

function composerLock(text: string, out: Map<string, string>): void {
  const doc = parseJson(text);
  if (!isRecord(doc)) return;
  for (const group of ["packages", "packages-dev"]) {
    const list = doc[group];
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isRecord(item) && typeof item.name === "string" && typeof item.version === "string") put(out, item.name, item.version);
  }
}

function gemfileLock(text: string, out: Map<string, string>): void {
  let specs = false;
  for (const line of text.split("\n")) {
    if (/^ {2}specs:\s*$/.test(line)) {
      specs = true;
      continue;
    }
    if (/^\S/.test(line)) specs = false;
    if (!specs) continue;
    const match = /^ {4}([^\s(]+) \(([^)]+)\)\s*$/.exec(line);
    if (match) put(out, match[1]!, match[2]!);
  }
}

function gradleLock(text: string, out: Map<string, string>): void {
  for (const line of text.split("\n")) {
    const match = /^([^#\s:=]+:[^\s:=]+):([^\s:=]+)=/.exec(line);
    if (match) put(out, match[1]!, match[2]!);
  }
}

function denoLock(text: string, out: Map<string, string>): void {
  const doc = parseJson(text);
  if (!isRecord(doc)) return;
  for (const group of ["npm", "jsr"]) {
    const list = isRecord(doc[group]) ? doc[group] : isRecord(doc.packages) && isRecord((doc.packages as Record<string, unknown>)[group]) ? (doc.packages as Record<string, unknown>)[group] : null;
    if (!isRecord(list)) continue;
    for (const key of Object.keys(list)) {
      const at = key.lastIndexOf("@");
      if (at > 0) put(out, key.slice(0, at), key.slice(at + 1).replace(/_.*$/, ""));
    }
  }
}

/** The resolved name -> version map of one lockfile's text (empty for an unknown or unparsable one). */
export function resolvedVersions(lockfileName: string, text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    switch (LOCKFILE_ECOSYSTEMS[lockfileName]) {
      case "npm": npmLock(text, out); break;
      case "pnpm": pnpmLock(text, out); break;
      case "yarn": yarnLock(text, out); break;
      case "bun": bunLock(text, out); break;
      case "poetry": case "uv": case "pdm": case "cargo": tomlPackages(text, out); break;
      case "pipenv": pipfileLock(text, out); break;
      case "pip": requirements(text, out); break;
      case "go": goSum(text, out); break;
      case "composer": composerLock(text, out); break;
      case "bundler": gemfileLock(text, out); break;
      case "gradle": gradleLock(text, out); break;
      case "deno": denoLock(text, out); break;
      default: break;
    }
  } catch {
    // A malformed lockfile: what was read so far.
  }
  return out;
}

/** The lockfile basename `toolchainProject` reads, or null when the name is not one it knows. */
export function lockfileEcosystem(name: string): Ecosystem | null {
  return LOCKFILE_ECOSYSTEMS[name] ?? null;
}

/**
 * One subproject's record. `lockfile` is workspace-relative; `manifests` the
 * manifest names present beside it (workspace-relative); `text` the
 * lockfile's content.
 */
export function toolchainProject(lockfile: string, manifests: readonly string[], text: string): ToolchainProject | null {
  const name = lockfile.split("/").at(-1) ?? "";
  const ecosystem = lockfileEcosystem(name);
  if (!ecosystem) return null;
  const dir = lockfile.includes("/") ? lockfile.slice(0, lockfile.lastIndexOf("/")) : ".";
  const all = [...resolvedVersions(name, text)].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const kept = all.slice(0, MAX_RESOLVED_PER_PROJECT);
  return { dir, ecosystem, lockfile, manifests: [...manifests].sort(), resolved: Object.fromEntries(kept), count: all.length, truncated: all.length > kept.length };
}

/** Projects in a stable order (by dir, then lockfile), at most MAX_TOOLCHAIN_PROJECTS. */
export function sortToolchainProjects(projects: ToolchainProject[]): ToolchainProject[] {
  return projects
    .sort((left, right) => (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : left.lockfile < right.lockfile ? -1 : left.lockfile > right.lockfile ? 1 : 0))
    .slice(0, MAX_TOOLCHAIN_PROJECTS);
}
