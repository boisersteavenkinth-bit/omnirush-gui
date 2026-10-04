// #18 Shell aliases and shims that change which toolchain a command runs
// (`alias python=python3`, `pip() { pip3 "$@"; }`, `Set-Alias python py`,
// `python` on PATH being a symlink to python3.12 or a version-manager shim).
// The rc files are read as text and lightly parsed; nothing is sourced or
// run. Values go through the secret scrub (an alias can carry a token).

import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

import { resolveCommand } from "./exec.js";
import { cleanText, tildePath, type PrivacyContext, type Scrubber } from "./privacy.js";

const MAX_RC_BYTES = 512 * 1024;
const MAX_ALIASES = 200;
const MAX_VALUE_CHARS = 500;

/** Commands whose aliases matter to a toolchain. */
export const TOOLCHAIN_COMMANDS = new Set([
  "python", "python2", "python3", "py", "pip", "pip3", "pipx", "uv", "uvx", "poetry", "pipenv", "conda", "mamba", "virtualenv", "pyenv",
  "node", "npm", "npx", "yarn", "pnpm", "pnpx", "bun", "bunx", "deno", "tsc", "ts-node", "tsx", "nvm", "volta", "fnm", "corepack",
  "git", "go", "gofmt", "cargo", "rustc", "rustup", "java", "javac", "mvn", "gradle", "kotlin", "scala", "sbt",
  "ruby", "gem", "bundle", "rake", "rails", "php", "composer", "dotnet", "swift", "make", "cmake", "cc", "gcc", "g++", "clang", "clang++",
  "docker", "docker-compose", "podman", "kubectl", "helm", "terraform", "mise", "asdf", "rbenv", "sdk",
]);

export type ShellAlias = { name: string; value: string; file: string; kind: "alias" | "function" | "doskey" | "set-alias" | "abbr" };
export type ShellShim = { name: string; target: string; kind: "symlink" | "shim" };
export type ShellAliases = { aliases: ShellAlias[]; shims: ShellShim[] };

function firstWord(value: string): string {
  const word = value.trim().replace(/^(?:command|builtin|exec|env|noglob|nocorrect)\s+/, "").split(/\s+/)[0] ?? "";
  return basename(word.replace(/^["']|["']$/g, ""));
}

function relevant(name: string, value: string): boolean {
  return TOOLCHAIN_COMMANDS.has(name) || TOOLCHAIN_COMMANDS.has(firstWord(value).replace(/\.exe$/i, ""));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
  return trimmed;
}

/** Aliases of POSIX shells (bash, zsh, sh): `alias a=b`, `alias -g a='b c'`, one-line functions `a() { b "$@"; }`. */
export function parsePosixRc(text: string): Array<{ name: string; value: string; kind: ShellAlias["kind"] }> {
  const out: Array<{ name: string; value: string; kind: ShellAlias["kind"] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const statement of line.split(/;\s*(?=alias\s)/)) {
      const alias = /^alias\s+(?:-[a-zA-Z]+\s+)*([\w.+-]+)=(.*)$/.exec(statement.trim());
      if (alias) {
        out.push({ name: alias[1]!, value: unquote(alias[2]!.replace(/\s+#.*$/, "")), kind: "alias" });
        continue;
      }
    }
    const fn = /^(?:function\s+)?([\w.+-]+)\s*(?:\(\s*\))?\s*\{\s*(.+?);?\s*\}\s*$/.exec(line);
    if (fn && (line.includes("()") || line.startsWith("function"))) out.push({ name: fn[1]!, value: fn[2]!.trim(), kind: "function" });
  }
  return out;
}

/** fish: `alias a 'b'`, `alias a=b`, `abbr -a a b`. */
export function parseFishRc(text: string): Array<{ name: string; value: string; kind: ShellAlias["kind"] }> {
  const out: Array<{ name: string; value: string; kind: ShellAlias["kind"] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const alias = /^alias\s+([\w.+-]+)(?:=|\s+)(.+)$/.exec(line);
    if (alias) out.push({ name: alias[1]!, value: unquote(alias[2]!), kind: "alias" });
    const abbr = /^abbr\s+(?:-a\s+|--add\s+)?(?:-g\s+)?([\w.+-]+)\s+(.+)$/.exec(line);
    if (abbr) out.push({ name: abbr[1]!, value: unquote(abbr[2]!), kind: "abbr" });
  }
  return out;
}

/** PowerShell: `Set-Alias python py`, `New-Alias -Name x -Value y`, `function python { py @args }`. */
export function parsePowerShellRc(text: string): Array<{ name: string; value: string; kind: ShellAlias["kind"] }> {
  const out: Array<{ name: string; value: string; kind: ShellAlias["kind"] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const named = /^(?:Set|New)-Alias\s+(?:-Name\s+)?([\w.+-]+)\s+(?:-Value\s+)?(\S+)/i.exec(line);
    if (named) out.push({ name: named[1]!, value: unquote(named[2]!), kind: "set-alias" });
    const fn = /^function\s+([\w.+-]+)\s*\{\s*(.+?)\s*\}\s*$/i.exec(line);
    if (fn) out.push({ name: fn[1]!, value: fn[2]!, kind: "function" });
  }
  return out;
}

/** cmd.exe autorun macros: `doskey python=py $*`. */
export function parseDoskey(text: string): Array<{ name: string; value: string; kind: ShellAlias["kind"] }> {
  const out: Array<{ name: string; value: string; kind: ShellAlias["kind"] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^(?:@?doskey\s+)?([\w.+-]+)=(.+)$/i.exec(raw.trim());
    if (match && !/^\s*(?:rem|::)/i.test(raw)) out.push({ name: match[1]!, value: match[2]!.trim(), kind: "doskey" });
  }
  return out;
}

type RcFile = { path: string; parse: (text: string) => Array<{ name: string; value: string; kind: ShellAlias["kind"] }> };

export function rcFiles(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): RcFile[] {
  const zdot = env.ZDOTDIR ?? home;
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const files: RcFile[] = [
    ...[".bashrc", ".bash_profile", ".bash_aliases", ".bash_login", ".profile", ".aliases", ".shrc", ".kshrc"].map((name) => ({ path: join(home, name), parse: parsePosixRc })),
    ...[".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zsh_aliases"].map((name) => ({ path: join(zdot, name), parse: parsePosixRc })),
    { path: join(xdg, "fish", "config.fish"), parse: parseFishRc },
  ];
  if (platform === "win32") {
    const documents = join(env.USERPROFILE ?? home, "Documents");
    for (const dir of ["PowerShell", "WindowsPowerShell"]) {
      for (const name of ["Microsoft.PowerShell_profile.ps1", "profile.ps1"]) files.push({ path: join(documents, dir, name), parse: parsePowerShellRc });
    }
    if (env.MACROS_FILE) files.push({ path: env.MACROS_FILE, parse: parseDoskey });
    files.push({ path: join(home, "macros.doskey"), parse: parseDoskey });
  } else {
    files.push({ path: join(xdg, "powershell", "Microsoft.PowerShell_profile.ps1"), parse: parsePowerShellRc });
  }
  return files;
}

const SHIM_DIRS = /[\\/](?:\.pyenv|\.rbenv|\.nodenv|\.goenv|\.jenv|\.asdf|\.local[\\/]share[\\/]mise|\.volta|\.proto|\.rye)[\\/](?:shims|bin)(?:[\\/]|$)|[\\/]shims[\\/]/;
const SHIM_NAMES = ["python", "python3", "pip", "pip3", "node", "npm", "npx", "java", "ruby", "go", "cargo", "cc", "gcc", "yarn", "pnpm"];

/** `python` → `python3.12` when it is a symlink on PATH; a version manager's shim as such. */
export async function pathShims(resolve: (command: string) => string | null = resolveCommand): Promise<ShellShim[]> {
  const out: ShellShim[] = [];
  for (const name of SHIM_NAMES) {
    const path = resolve(name);
    if (!path) continue;
    if (SHIM_DIRS.test(path)) {
      const manager = /\.(pyenv|rbenv|nodenv|goenv|jenv|asdf|volta|proto|rye)|mise/.exec(path)?.[0]?.replace(/^\./, "") ?? "shim";
      out.push({ name, target: manager, kind: "shim" });
      continue;
    }
    try {
      if (!(await lstat(path)).isSymbolicLink()) continue;
      const target = basename(await readlink(path));
      if (target && target !== name) out.push({ name, target, kind: "symlink" });
    } catch {
      // Not readable.
    }
  }
  return out;
}

export type ShellAliasOptions = {
  privacy: PrivacyContext;
  scrub: Scrubber;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolve?: (command: string) => string | null;
};

export async function collectShellAliases(options: ShellAliasOptions): Promise<ShellAliases> {
  const home = options.privacy.home;
  const aliases: ShellAlias[] = [];
  if (home) {
    const seen = new Set<string>();
    for (const file of rcFiles(home, options.platform ?? process.platform, options.env)) {
      if (seen.has(file.path) || aliases.length >= MAX_ALIASES) continue;
      seen.add(file.path);
      let text: string;
      try {
        const buffer = await readFile(file.path);
        if (buffer.length > MAX_RC_BYTES) continue;
        text = buffer.toString("utf8");
      } catch {
        continue;
      }
      for (const entry of file.parse(text)) {
        if (!relevant(entry.name, entry.value) || aliases.length >= MAX_ALIASES) continue;
        const value = cleanText(entry.value, options.privacy, options.scrub);
        aliases.push({
          name: entry.name,
          value: value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value,
          file: tildePath(file.path, options.privacy),
          kind: entry.kind,
        });
      }
    }
  }
  return { aliases, shims: await pathShims(options.resolve) };
}
