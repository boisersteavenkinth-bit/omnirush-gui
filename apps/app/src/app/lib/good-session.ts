// "Good session ★": the live checklist and the don't-quit-mid-turn guard.
//
// A Good session is one the server's strict check passes (omnirush-backend:
// session_repro.py REASONS and WorkSize.floor, the Session QC V2 gate, Session
// QC V3's blocking checks and quality_rewards.STRICT_SPINS_TEXT). The rules
// below mirror the parts of that check a turn can see as it runs. They never
// show a check as passed where the server's check fails; the filled ★ comes
// only from the server's verdict, after upload.
//
//   code     WorkSize.floor's code part: 2+ project code files and 30+ lines
//            changed, or 5+ files and 150+ lines (session_qc.is_code_path,
//            session_repro._written_lines)
//   ran      a build or test run (session_qc.BUILD_TEST, WorkSize.test_runs)
//   project  the work stays inside the project folder (V3 outside_path,
//            home_folder, shell writes outside it), with no personal or
//            outside service (V3 remote_service, local_database, remote_git,
//            docker, public_web, private_web, external_browser,
//            local_service) and no machine-specific program (V3
//            host_only_program)
//   finished the last turn finished (V3 unrecorded_turn, V2 `finished`)
//   windows  not native Windows (V3 windows_host); WSL is fine
//
// Sub-agents and many turns are not required.
//
// The rules (everything from "Code files" to "The don't-quit-mid-turn guard")
// are the same, line for line, as the CLI's
// assets/extensions/omnirush/good-session-lib.js; only the types differ. The
// desktop's own part is `messageFacts` (the transcript as tool calls).

import type { UIMessage } from "ai";

export const GOOD_SESSION_LABEL = "Good session ★";
/** All local checks pass; the server decides after upload. */
export const GOOD_SESSION_ON_TRACK = "On track for a Good session ★ (final check after upload)";

/** The four steps the rewards panel and the checklist's link show. */
export const GOOD_SESSION_GUIDE: readonly string[] = Object.freeze([
  "Work inside your project folder.",
  "Build or change real code.",
  "Run it or its tests.",
  "Let the last turn finish.",
]);
export const GOOD_SESSION_WSL_TIP = "On Windows? Use WSL.";
export const GOOD_SESSION_GUIDE_LINK = "How to make a Good session";

/** The console's WSL guide (omnirush-console app/console/wsl, lib/wsl-guide). */
export const WSL_GUIDE_URL = "https://omnirush.ai/console/wsl";
export const WSL_BANNER_TEXT = "Sessions from native Windows don't count as Good sessions. Switch to WSL";

export const TURN_GUARD_TITLE = "A turn is still running.";
export const TURN_GUARD_DETAIL = `Quit now and this session won't count as a ${GOOD_SESSION_LABEL}.`;
export const TURN_GUARD_MESSAGE = `${TURN_GUARD_TITLE} ${TURN_GUARD_DETAIL}`;
export const TURN_GUARD_WAIT = "Wait for it";
export const TURN_GUARD_QUIT = "Quit anyway";

export const NUDGE_TITLE = `Not a ${GOOD_SESSION_LABEL} yet`;

/**
 * Server texts that still say "replay-ready ★" (older servers): users read
 * "Good session ★" everywhere.
 */
export function goodSessionWording(text: string): string;
export function goodSessionWording(text: string | null | undefined): string | null | undefined;
export function goodSessionWording(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return String(text)
    .replace(/\breplay[- ]ready ★ sessions\b/gi, "Good sessions ★")
    .replace(/\breplay[- ]ready ★ session\b/gi, "Good session ★")
    .replace(/\breplay[- ]ready ★/gi, GOOD_SESSION_LABEL)
    .replace(/★ ?replay[- ]ready sessions\b/gi, "★ Good sessions")
    .replace(/\breplay[- ]ready sessions\b/gi, "Good sessions")
    .replace(/\breplay[- ]ready session\b/gi, "Good session")
    .replace(/\breplay[- ]ready\b/gi, "Good session");
}

// --- Code files (session_qc.is_code_path) -----------------------------------

const NON_CODE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".rst", ".adoc", ".org", ".rtf", ".doc", ".docx", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff", ".avif", ".heic",
  ".ttf", ".otf", ".woff", ".woff2", ".eot", ".mp3", ".wav", ".mp4", ".mov", ".log", ".csv",
  ".tsv", ".jsonl", ".xlsx", ".pptx", ".sqlite", ".sqlite3", ".db", ".bin", ".zip", ".tar",
  ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".whl",
]);
const INTERNAL_DIRS = [
  "__agent__/", ".omnirush/", ".opencode/", ".pi/", ".godot/", ".git/", "node_modules/", ".venv/",
  "venv/", "__pycache__/", ".idea/", ".vscode/", ".next/", ".nuxt/", ".svelte-kit/", ".turbo/",
  ".cache/", ".parcel-cache/", "coverage/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
  ".gradle/", "cmake-build-",
];
const BUILD_OUTPUT_DIRS = new Set(["dist", "build", "out", "target"]);
const SOURCE_DIRS = new Set(["src", "app", "lib", "main", "java", "kotlin"]);
const GENERATED_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "packages.lock.json", "pnpm-lock.yaml", "go.sum"]);
const GENERATED_SUFFIXES = [
  ".lock", ".lockb", ".tsbuildinfo", ".sst", ".map", ".min.js", ".min.css", ".pyc", ".pyo", ".o",
  ".obj", ".a", ".class", ".jar", ".so", ".dll", ".dylib", ".exe", ".wasm",
];
const CODE_FILENAMES = new Set([
  "dockerfile", "containerfile", "makefile", "gnumakefile", "justfile", "gemfile", "rakefile",
  "podfile", "brewfile", "jenkinsfile", "procfile", "vagrantfile", "build", "workspace",
  "cmakelists.txt", "package.json", "cargo.toml", "go.mod", "pyproject.toml",
]);
const REQUIREMENTS_FILE = /^requirements[\w.-]*\.(txt|in)$/;
const SCRIPT_DIRS = new Set(["bin", "scripts"]);
const AGENT_NOTES = new Set(["swarm.md", "plan.json", "readme"]);
const SCRATCH_PREFIXES = ["/tmp/", "/var/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/dev/"];
const WINDOWS_SCRATCH = /^[a-z]:\/windows\/temp\/|\/appdata\/local\/temp\//;
const WINDOWS_DRIVE = /^[a-z]:\//;

function normPath(value: unknown): string {
  let norm = String(value).replace(/\\/g, "/").toLowerCase();
  while (norm.startsWith("./")) norm = norm.slice(2);
  return norm;
}

function isScratch(norm: string): boolean {
  return SCRATCH_PREFIXES.some((prefix) => norm.startsWith(prefix)) || WINDOWS_SCRATCH.test(norm);
}

function notProject(norm: string): boolean {
  if (isScratch(norm)) return true;
  if (INTERNAL_DIRS.some((dir) => norm.startsWith(dir) || norm.includes(`/${dir}`))) return true;
  const folders = norm.split("/").slice(0, -1);
  const absolute = norm.startsWith("/") || norm.startsWith("~/") || WINDOWS_DRIVE.test(norm);
  return folders.some((folder, index) => BUILD_OUTPUT_DIRS.has(folder)
    && ((!absolute && index === 0) || (absolute && index > 0 && !SOURCE_DIRS.has(folders[index - 1] ?? ""))));
}

/** Whether a changed file counts as project code (session_qc.is_code_path). */
export function isCodePath(value: unknown): boolean {
  const norm = normPath(String(value ?? "").trim());
  if (!norm || notProject(norm)) return false;
  const folders = norm.split("/").slice(0, -1);
  const name = norm.slice(norm.lastIndexOf("/") + 1);
  if (!name) return false;
  if (GENERATED_FILES.has(name) || GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (CODE_FILENAMES.has(name) || REQUIREMENTS_FILE.test(name)) return true;
  if (folders.at(-1) === "requirements" && name.endsWith(".txt")) return true;
  if (AGENT_NOTES.has(name)) return false;
  if (!name.includes(".")) return folders.some((folder) => SCRIPT_DIRS.has(folder));
  return !NON_CODE_EXTENSIONS.has(name.slice(name.lastIndexOf(".")));
}

/** WorkSize.floor's code part: files and lines (the build/test part is the `ran` check). */
export const FLOOR_FILES = 2;
export const FLOOR_LINES = 30;
export const FLOOR_ALONE_FILES = 5;
export const FLOOR_ALONE_LINES = 150;

/** Lines an edit put in (session_repro._written_lines; apply_patch: its added lines). */
export function writtenLines(input: unknown): number {
  const value = record(input);
  for (const key of ["content", "newString", "new_string", "new_str", "newText", "new_text"]) {
    if (typeof value[key] === "string") return (value[key] as string).split("\n").length;
  }
  if (Array.isArray(value.edits)) {
    return value.edits.reduce((total: number, edit: unknown) => total + writtenLines(edit), 0);
  }
  const patch = str(value.patchText) || str(value.patch) || str(value.input);
  return patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
}

// --- Commands (session_qc.BUILD_TEST, session_qc_v2._runs, V3) ----------------

/** A build, a test run or a linter/type check (session_qc.BUILD_TEST): what WorkSize.test_runs counts. */
const BUILD_TEST = new RegExp(
  String.raw`^(pytest|unittest|tox|nox|npm (run )?(test|build|lint)|`
  + String.raw`yarn (test|build)|pnpm (test|build)|bun test|jest|vitest|mocha|`
  + String.raw`go (test|build|vet)|cargo (test|build|check|clippy)|make\b|cmake|`
  + String.raw`mvn|gradle|dotnet (test|build)|tsc\b|eslint|ruff|mypy|flake8|`
  + String.raw`black --check|gcc|g\+\+|clang|javac|rustc|`
  + String.raw`python3? -m (pytest|unittest|py_compile)|node --test|php(unit)?|`
  + String.raw`rspec)`,
  "i",
);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const WRAPPERS = new Set(["sudo", "time", "nice", "env", "exec", "command", "timeout", "npx", "bunx", "pnpx", "uv", "poetry", "run"]);

/** The commands of a shell line, each as its words (V2 `_split`/`_words`). */
export function commandSegments(command: unknown): string[][] {
  return String(command ?? "")
    .split(/\n|&&|\|\||;|\||\(|\)|`|\$\(|&/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      while (words.length) {
        const first = words[0]!;
        if (ENV_ASSIGN.test(first)) { words.shift(); continue; }
        if (WRAPPERS.has(first)) {
          words.shift();
          while (/^-/.test(words[0] ?? "")) words.shift();
          if (first === "timeout" && /^\d/.test(words[0] ?? "")) words.shift();
          continue;
        }
        break;
      }
      return words;
    })
    .filter((words) => words.length > 0);
}

/** Whether a shell line builds or tests (session_qc.BUILD_TEST, the only runs WorkSize counts). */
export function ranSomething(command: unknown): boolean {
  return commandSegments(command).some((words) => BUILD_TEST.test(words.join(" ")));
}

const REMOTE_PROGRAMS = new Set([
  "gh", "glab", "ssh", "scp", "sftp", "aws", "gcloud", "az", "vercel", "netlify", "firebase",
  "supabase", "wrangler", "flyctl", "fly", "heroku", "railway", "kubectl", "helm", "terraform",
  "doctl", "ngrok", "cloudflared", "gsutil", "eas",
]);
/** Programs only the user's machine has (V3 HOST_PROGRAMS, plus the desktop openers). */
const HOST_PROGRAMS = new Set([
  "osascript", "xcodebuild", "xcrun", "sips", "qlmanage", "pbcopy", "pbpaste", "defaults", "launchctl",
  "safaridriver", "system_profiler", "ioreg", "diskutil", "powershell", "powershell.exe", "pwsh", "cmd",
  "cmd.exe", "wsl", "wsl.exe", "adb", "fastboot", "nvidia-smi", "systemctl", "journalctl", "networksetup",
  "java_home", "nix", "nix-shell", "nix-build", "nix-env", "flutter", "dart", "swift", "swiftc",
  "open", "xdg-open", "start", "explorer.exe", "notify-send", "xclip", "xsel",
]);
const DB_CLIENTS = new Set(["psql", "pgcli", "mysql", "mariadb", "mycli", "mongosh", "mongo", "redis-cli"]);
const DOCKER_PROGRAMS = new Set(["docker", "docker-compose", "podman"]);
const FETCHERS = new Set(["curl", "wget", "http", "https", "httpie", "xh", "aria2c", "fetch"]);
const PROBE_ARGS = new Set(["--help", "--version", "--dry-run", "--dryrun", "-h", "-v"]);
const GIT_REMOTE = /\bgit\s+(-C\s+\S+\s+)?(clone|fetch|pull|push|ls-remote)\b/;
const DB_SETUP = /createdb|create\s+database|initdb|\bmigrate\b|db:migrate|db\s+push|alembic\s+upgrade|drizzle-kit\s+(push|migrate)|\bseed\b|db:seed/i;
const QUOTED = /'[^']*'|"[^"]*"/g;
const URL_ARG = /^['"]?(https?:\/\/[^\s'"]+|(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/[^\s'"]*)?)/i;
/** A server on this machine (V3 LOCAL_URL). */
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.localhost)(:\d+)?(\/|$|\?|#)|^(file|about|data):/i;
/** A command that starts a local server, so later calls to localhost reach it (V3 SERVER_START). */
const SERVER_START = new RegExp(
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b|`
  + String.raw`\bnpx\s+(vite(?!\s+build)|serve|http-server|live-server|nodemon)\b|`
  + String.raw`\bvite(\s+(dev|serve|preview)\b|\s+--|\s*$)|`
  + String.raw`\b(nodemon|live-server|http-server)\s|\bnext\s+(dev|start)\b|`
  + String.raw`\bpython3?\s+-m\s+(http\.server|uvicorn|flask|streamlit|gunicorn)\b|`
  + String.raw`\b(uvicorn|gunicorn|hypercorn|daphne)\s|\bflask\s+run\b|`
  + String.raw`manage\.py\s+runserver|\brails\s+s(erver)?\b|\bphp\s+-S\b|`
  + String.raw`\bstreamlit\s+run\b|\b(go|cargo)\s+run\b|\bdeno\s+(run|task)\b|`
  + String.raw`\b(hugo|jekyll)\s+serve|\bexpo\s+start\b|\bwrangler\s+dev\b|`
  + String.raw`\b(vercel|netlify)\s+dev\b|\bollama\s+serve\b|\bredis-server\b|`
  + String.raw`\bmongod\b|\bpg_ctl\s+start\b|\bdocker(-compose|\s+compose)?\s+(up|run)\b|`
  + String.raw`\bnode\s+\S*(server|app|index|main)\S*\.(c|m)?[jt]s\b`,
  "i",
);

/** Whether a shell line starts a local server (V3 SERVER_START). */
export function startsServer(command: unknown): boolean {
  return SERVER_START.test(String(command ?? ""));
}

/** The web addresses a shell line fetches with curl, wget and the like. */
export function fetchedUrls(command: unknown): string[] {
  const urls: string[] = [];
  for (const words of commandSegments(command)) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    if (!FETCHERS.has(program)) continue;
    for (const word of words.slice(1)) {
      const match = URL_ARG.exec(word);
      if (match) urls.push(match[1]!);
    }
  }
  return urls;
}

/**
 * What takes a shell line outside the project (V3 remote_service,
 * local_database, remote_git, docker, public_web, host_only_program), as a
 * short name, or null. Calls to this machine (`curl localhost:3000`) are
 * judged by the checklist, which knows whether the session started a server.
 */
export function personalService(command: unknown, { dbBuilt = false }: { dbBuilt?: boolean } = {}): string | null {
  const bare = String(command ?? "").replace(QUOTED, " ");
  if (GIT_REMOTE.test(bare)) return "a remote git repository";
  for (const words of commandSegments(bare)) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    if (words.slice(1).some((word) => PROBE_ARGS.has(word))) continue;
    if (REMOTE_PROGRAMS.has(program)) return program;
    if (DOCKER_PROGRAMS.has(program)) return "docker";
    if (DB_CLIENTS.has(program) && !dbBuilt) return program;
    if (HOST_PROGRAMS.has(program)) return `${program}, a program only your machine has`;
  }
  const remote = fetchedUrls(command).find((url) => !LOCAL_URL.test(url));
  if (remote) return `the web (${remote.slice(0, 60)})`;
  return null;
}

/** The files a shell line writes or removes: redirects, tee, cp/mv targets, rm/mkdir/touch arguments. */
export function shellWrites(command: unknown): string[] {
  const text = String(command ?? "");
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|[^<>&\d])\d?>>?\s*(['"]?)([^\s'";&|<>)]+)\1/g)) {
    if (!match[2]!.startsWith("&")) out.push(match[2]!);
  }
  for (const words of commandSegments(text.replace(/\d?>>?\s*\S+/g, " "))) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    const args = words.slice(1).filter((word) => !word.startsWith("-")).map((word) => word.replace(/^['"]|['"]$/g, ""));
    if (program === "tee" || program === "rm" || program === "rmdir" || program === "mkdir" || program === "touch" || program === "chmod") {
      out.push(...(program === "chmod" ? args.slice(1) : args));
    } else if ((program === "cp" || program === "mv" || program === "ln" || program === "install" || program === "rsync") && args.length >= 2) {
      out.push(args.at(-1)!);
      if (program === "mv") out.push(...args.slice(0, -1));
    }
  }
  return out;
}

// --- Folders ---------------------------------------------------------------

const HOME_FOLDER = /^(\/home\/[^/]+|\/users\/[^/]+|\/root|[a-z]:\/users\/[^/]+|~)\/?$/;
const HOME_PREFIX = /^(\/home\/[^/]+|\/users\/[^/]+|\/root|[a-z]:\/users\/[^/]+)(\/|$)/;

function folderKey(value: unknown): string {
  return normPath(String(value ?? "").trim()).replace(/\/+$/, "");
}

/** The project folder is the home folder itself (V3 home_folder). */
export function isHomeFolder(root: unknown): boolean {
  return HOME_FOLDER.test(folderKey(root));
}

function isAbsolute(norm: string): boolean {
  return norm.startsWith("/") || norm.startsWith("~") || norm.startsWith("$home") || WINDOWS_DRIVE.test(norm);
}

function resolveDots(value: string): string {
  const out: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "..") {
      if (out.length > 1) out.pop();
    } else if (segment !== "." && (segment || out.length === 0)) {
      out.push(segment);
    }
  }
  return out.join("/");
}

function homeSplit(norm: string): { home: string; rest: string } | null {
  const tilde = /^(~|\$home|\$\{home\})(\/|$)/.exec(norm);
  if (tilde) return { home: "~", rest: norm.replace(/^(~|\$home|\$\{home\})(\/|$)/, "") };
  const match = HOME_PREFIX.exec(norm);
  return match ? { home: match[1], rest: norm.slice(match[1].length + 1) } : null;
}

/** Whether a path the agent changed or worked in is outside the project folder (scratch folders are fine). */
export function outsideProject(file: unknown, root: unknown): boolean {
  let norm = folderKey(file);
  const base = folderKey(root);
  if (!norm || !base) return false;
  const baseSplit = homeSplit(base);
  const normSplit = homeSplit(norm);
  if (baseSplit && normSplit && (baseSplit.home === "~" || normSplit.home === "~" || baseSplit.home === normSplit.home)) {
    // Both sides sit under the same home folder (`~/...` matches its absolute form):
    // compare the part below the home folder.
    return normSplit.rest !== baseSplit.rest && !normSplit.rest.startsWith(`${baseSplit.rest}/`);
  }
  if (/^(~|\$home|\$\{home\})(\/|$)/.test(norm)) {
    // `~/x`: under the home folder the project folder sits in, when it sits in one.
    const home = HOME_PREFIX.exec(base)?.[1];
    if (!home) return true;
    norm = norm.replace(/^(~|\$home|\$\{home\})/, home);
  }
  if (!isAbsolute(norm)) {
    // Relative to the project folder: only `..` can leave it.
    if (!norm.split("/").includes("..")) return false;
    norm = resolveDots(`${base}/${norm}`);
  } else {
    norm = resolveDots(norm);
  }
  if (isScratch(`${norm}/`)) return false;
  return norm !== base && !norm.startsWith(`${base}/`);
}

// --- Tool calls -------------------------------------------------------------------

const EDIT_TOOLS = new Set([
  "edit", "write", "patch", "multiedit", "apply_patch", "str_replace", "str_replace_editor", "create", "notebookedit",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "run", "exec", "terminal", "execute", "bash_output"]);
const WEB_TOOLS = new Set(["webfetch", "web_fetch", "websearch", "web_search"]);
const BROWSER_TOOL = /^browser_|^(playwright|puppeteer|chrome)[_-]/;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** A call the engine or the user refused, so nothing ran (bad arguments, an unknown tool, a denied permission). */
const NOT_RUN = /invalid arguments|no tool named|unknown tool|tool .{0,40}not (found|available)|permission .{0,20}(denied|rejected)|user (rejected|denied|dismissed)/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type ToolCall = { tool: string; input: Record<string, unknown>; failed: boolean; notRun: boolean; unfinished: boolean };

/**
 * One tool call, from either engine: { tool, input, failed, errorText,
 * unfinished }. `failed`: the call ended in an error; `errorText`: what the
 * error said (a refusal counts for nothing); `unfinished`: it never ended.
 */
export function toolCall({ tool, input, failed = false, errorText = "", unfinished = false }: {
  tool?: unknown; input?: unknown; failed?: boolean; errorText?: unknown; unfinished?: boolean;
} = {}): ToolCall {
  const isFailed = Boolean(failed);
  return {
    tool: String(tool ?? "").toLowerCase().replace(/^.*[.:]/, ""),
    input: record(input),
    failed: isFailed,
    notRun: isFailed && NOT_RUN.test(str(errorText)),
    unfinished: Boolean(unfinished),
  };
}

/** The files an edit tool changed: its path field, or the files its patch names. */
export function editedPaths(input: unknown): string[] {
  const value = record(input);
  const direct = str(value.filePath) || str(value.file_path) || str(value.path) || str(value.file) || str(value.target_file);
  if (direct) return [direct];
  const patch = str(value.patchText) || str(value.patch) || str(value.input);
  const paths: string[] = [];
  for (const match of patch.matchAll(PATCH_FILE)) {
    const file = (match[1] ?? match[2] ?? "").trim();
    if (file) paths.push(file);
  }
  return paths;
}

function shellCommand(input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd ?? input.script;
  if (Array.isArray(command)) return command.filter((word) => typeof word === "string").join(" ");
  return str(command);
}

function shellFolders(command: string, input: Record<string, unknown>): string[] {
  const folders = [str(input.workdir), str(input.cwd), str(input.directory)].filter(Boolean);
  for (const words of commandSegments(command.replace(QUOTED, (quoted) => quoted.slice(1, -1).replace(/\s/g, "\u0000")))) {
    if ((words[0] === "cd" || words[0] === "pushd") && words[1]) folders.push(words[1].replace(/\u0000/g, " "));
  }
  return folders;
}

function toolUrl(input: Record<string, unknown>): string {
  return str(input.url) || str(input.href) || str(input.uri);
}

// --- The checklist -----------------------------------------------------------

export type GoodSessionCheckId = "code" | "ran" | "project" | "finished" | "windows";
export type GoodSessionCheckState = "pass" | "fail" | "pending";

export type GoodSessionCheck = {
  id: GoodSessionCheckId;
  state: GoodSessionCheckState;
  /** "code changed", "ran/tested", "in project", "finish your turn". */
  label: string;
  /** Why it fails, or what to do next. */
  hint: string;
};

/** "incomplete": a check fails or the turn runs; "on-track": every local check passes; "good": the server says so. */
export type GoodSessionVerdict = "incomplete" | "on-track" | "good";

export type GoodSessionChecklist = {
  checks: GoodSessionCheck[];
  verdict: GoodSessionVerdict;
  /** Every local check passes (the server still decides). */
  onTrack: boolean;
  /** The checks that still fail, without the running turn. */
  missing: GoodSessionCheck[];
  /** "Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn". */
  text: string;
  /** The work as WorkSize counts it. */
  work: { codeFiles: number; lines: number; testRuns: number };
};

export type GoodSessionInput = {
  /** toolCall()s, oldest first. */
  calls?: readonly ToolCall[];
  /** The project folder the session runs in. */
  workspaceRoot?: string;
  /** A turn is running (busy, retrying, waiting on a question or a permission). */
  turnRunning?: boolean;
  /** "pass": the last message is an answer with no session error and no unfinished tool call. */
  lastTurn?: "pass" | "cut";
  /** Native Windows (not WSL). */
  nativeWindows?: boolean;
  /** The server checked this session after upload and it is a Good session ★. */
  serverGood?: boolean;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The checklist for a session, from its tool calls. */
export function goodSessionChecklist({
  calls = [], workspaceRoot = "", turnRunning = false, lastTurn = "cut", nativeWindows = false, serverGood = false,
}: GoodSessionInput = {}): GoodSessionChecklist {
  const codeFiles = new Map<string, number>();
  let testRuns = 0;
  let outside: string | null = null;
  let service: string | null = null;
  let serverStarted = false;
  let localUnstarted: string | null = null;
  const home = String(workspaceRoot).trim() ? isHomeFolder(workspaceRoot) : false;
  const unknownRoot = !folderKey(workspaceRoot);
  const dbBuilt = calls.some((call) => SHELL_TOOLS.has(call.tool) && DB_SETUP.test(shellCommand(call.input)));
  const local = (url: string) => {
    if (!serverStarted) localUnstarted ??= url;
  };

  for (const call of calls) {
    if (call.notRun) continue;
    if (EDIT_TOOLS.has(call.tool)) {
      const files = editedPaths(call.input);
      for (const file of files) {
        if (outsideProject(file, workspaceRoot)) {
          outside ??= file;
          continue;
        }
        if (!call.failed && isCodePath(file)) {
          const key = folderKey(file);
          codeFiles.set(key, (codeFiles.get(key) ?? 0) + (files.length === 1 ? writtenLines(call.input) : 0));
        }
      }
      if (!call.failed && files.length > 1) {
        // A patch over several files: its added lines go to the first code file.
        const first = files.map(folderKey).find((key) => codeFiles.has(key));
        if (first) codeFiles.set(first, (codeFiles.get(first) ?? 0) + writtenLines(call.input));
      }
    } else if (SHELL_TOOLS.has(call.tool)) {
      const command = shellCommand(call.input);
      if (!command) continue;
      if (ranSomething(command)) testRuns += 1;
      service ??= personalService(command, { dbBuilt });
      for (const url of fetchedUrls(command)) if (LOCAL_URL.test(url)) local(url);
      if (startsServer(command)) serverStarted = true;
      for (const folder of [...shellFolders(command, call.input), ...shellWrites(command)]) {
        if (outsideProject(folder, workspaceRoot)) outside ??= folder;
      }
    } else if (WEB_TOOLS.has(call.tool) || BROWSER_TOOL.test(call.tool)) {
      const url = toolUrl(call.input);
      if (url && LOCAL_URL.test(url)) local(url);
      else if (url || WEB_TOOLS.has(call.tool)) service ??= `the web (${(url || call.tool).slice(0, 60)})`;
    }
  }

  const fileCount = codeFiles.size;
  const lines = [...codeFiles.values()].reduce((total, count) => total + count, 0);
  const code = (fileCount >= FLOOR_FILES && lines >= FLOOR_LINES) || (fileCount >= FLOOR_ALONE_FILES && lines >= FLOOR_ALONE_LINES);
  const codeShort = fileCount < FLOOR_FILES
    ? ` (${fileCount} of ${FLOOR_FILES} files)`
    : lines < FLOOR_LINES ? ` (${lines} of ${FLOOR_LINES} lines)` : "";
  const finished = turnRunning ? "pending" : lastTurn === "pass" ? "pass" : "cut";
  const noRoot = unknownRoot && calls.some((call) => !call.notRun);
  const checks: GoodSessionCheck[] = [
    {
      id: "code",
      state: code ? "pass" : "fail",
      label: `code changed${code ? "" : codeShort}`,
      hint: code
        ? `${plural(fileCount, "code file")} and ${plural(lines, "line")} changed.`
        : fileCount === 0
          ? "Build or change real code in the project."
          : `Build or change more real code: ${FLOOR_FILES}+ code files and ${FLOOR_LINES}+ lines.`,
    },
    {
      id: "ran",
      state: testRuns > 0 ? "pass" : "fail",
      label: "ran/tested",
      hint: testRuns > 0 ? "The agent ran a build or the tests." : "Ask the agent to build it or run its tests.",
    },
    {
      id: "project",
      state: home || noRoot || outside || service || localUnstarted ? "fail" : "pass",
      label: "in project",
      hint: home
        ? "The session runs in your home folder: open a project folder instead."
        : noRoot
          ? "No project folder open: open a project folder instead."
          : outside
          ? `Work outside the project folder: ${outside}`
          : service
            ? `Uses ${service}: keep the work inside the project.`
            : localUnstarted
              ? `Calls ${localUnstarted} without starting that server in the session: start it in the session.`
              : "The work stays inside the project folder.",
    },
    {
      id: "finished",
      state: finished === "cut" ? "fail" : finished,
      label: finished === "pending" ? "finish your turn" : finished === "pass" ? "turn finished" : "last turn cut off",
      hint: finished === "pending"
        ? "Let the turn finish: quitting or stopping now cuts it off."
        : finished === "pass"
          ? "The last turn finished."
          : "The last turn stopped before it finished: send a follow-up and let it finish.",
    },
  ];
  if (nativeWindows) {
    checks.push({ id: "windows", state: "fail", label: "native Windows", hint: "Sessions from native Windows don't count: use WSL." });
  }
  const missing = checks.filter((check) => check.state === "fail");
  const onTrack = checks.every((check) => check.state === "pass");
  const verdict: GoodSessionVerdict = onTrack ? (serverGood ? "good" : "on-track") : "incomplete";
  return { checks, verdict, onTrack, missing, text: checklistText(checks, verdict), work: { codeFiles: fileCount, lines, testRuns } };
}

function mark(check: GoodSessionCheck): string {
  if (check.state === "pending") return check.label;
  return `${check.label} ${check.state === "pass" ? "✓" : "✗"}`;
}

/** The checklist's heading: the filled ★ only on the server's word. */
export function checklistHeading(verdict: GoodSessionVerdict): string {
  return verdict === "good" ? GOOD_SESSION_LABEL : verdict === "on-track" ? GOOD_SESSION_ON_TRACK : "Good session";
}

/** "Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn". */
export function checklistText(checks: readonly GoodSessionCheck[], verdict: GoodSessionVerdict = "incomplete"): string {
  return `${checklistHeading(verdict)}: ${checks.map(mark).join(" · ")}`;
}

/** The one gentle nudge after a turn ends with something missing, or null. */
export function goodSessionNudge(checklist: Pick<GoodSessionChecklist, "missing"> | null | undefined): { title: string; body: string } | null {
  const missing = checklist?.missing ?? [];
  if (!missing.length) return null;
  return { title: NUDGE_TITLE, body: missing.map((check) => check.hint).join(" ") };
}

/** When to nudge: once per session, on the turn that just ended (running → not running), and only when something is missing. */
export function shouldNudge({ wasRunning, running, checklist, alreadyNudged }: {
  wasRunning: boolean; running: boolean; checklist: Pick<GoodSessionChecklist, "missing"> | null | undefined; alreadyNudged: boolean;
}): boolean {
  return Boolean(wasRunning && !running && !alreadyNudged && (checklist?.missing?.length ?? 0) > 0);
}

// --- The don't-quit-mid-turn guard --------------------------------------------

export type QuitGuard = {
  readonly state: "idle" | "asking" | "waiting";
  request(input?: { running?: boolean; interactive?: boolean; hangup?: boolean }): "quit" | "ask";
  answer(wait: boolean): "wait" | "quit";
  turnEnded(): boolean;
};

/**
 * `request({ running, interactive, hangup })` answers "quit" (go ahead) or
 * "ask" (show TURN_GUARD_MESSAGE with "Wait for it" / "Quit anyway"). The
 * first quit request while a turn runs asks; a second one, whatever the
 * answer, quits. `answer(wait)` takes the user's choice; `turnEnded()`
 * re-arms the guard for the next turn and says whether the user was waiting.
 * Headless runs and a closed terminal (hangup) never ask.
 */
export function createQuitGuard(): QuitGuard {
  let state: "idle" | "asking" | "waiting" = "idle";
  return {
    get state() {
      return state;
    },
    request({ running = false, interactive = true, hangup = false } = {}) {
      if (!interactive || hangup || !running) return "quit";
      if (state === "idle") {
        state = "asking";
        return "ask";
      }
      return "quit";
    },
    answer(wait) {
      if (state !== "asking") return wait ? "wait" : "quit";
      if (wait) {
        state = "waiting";
        return "wait";
      }
      return "quit";
    },
    turnEnded() {
      const was = state;
      state = "idle";
      return was === "waiting" || was === "asking";
    },
  };
}

// --- The desktop's transcript -------------------------------------------------

function sessionErrorOf(message: UIMessage): boolean {
  return message.parts.some((part) => {
    const metadata = record((part as { providerMetadata?: unknown }).providerMetadata);
    return record(metadata.opencode).sessionError !== undefined;
  });
}

function messageCalls(message: UIMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of message.parts) {
    const value = part as unknown as Record<string, unknown>;
    let tool = "";
    if (part.type === "dynamic-tool") tool = str(value.toolName);
    else if (part.type.startsWith("tool-")) tool = part.type.slice(5);
    else continue;
    calls.push(toolCall({
      tool,
      input: value.input,
      failed: value.state === "output-error",
      errorText: value.errorText,
      unfinished: value.state === "input-streaming" || value.state === "input-available",
    }));
  }
  return calls;
}

/** The desktop transcript as the checklist reads it: { calls, lastTurn } (the CLI's sessionFacts). */
export function messageFacts(messages: readonly UIMessage[]): { calls: ToolCall[]; lastTurn: "pass" | "cut" } {
  const calls: ToolCall[] = [];
  let lastCalls: ToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    lastCalls = messageCalls(message);
    calls.push(...lastCalls);
  }
  const last = messages.at(-1);
  const lastTurn = last && last.role === "assistant" && !sessionErrorOf(last) && !lastCalls.some((call) => call.unfinished) ? "pass" : "cut";
  return { calls, lastTurn };
}

/** Whether leaving (closing, quitting, switching or deleting) is about a session whose turn runs. */
export function leavingRunningTurn(input: { action: "close" | "quit" | "switch" | "delete"; turnRunning: boolean; targetSessionId?: string | null; currentSessionId?: string | null }): boolean {
  if (!input.turnRunning) return false;
  if (input.action === "switch") return Boolean(input.currentSessionId) && input.targetSessionId !== input.currentSessionId;
  return true;
}

// --- Native Windows ------------------------------------------------------------

export const WSL_BANNER_DISMISSED_KEY = "omnirush.goodSession.wslBannerDismissedDay.v1";

/** The local day ("2026-10-06"): a dismissed banner comes back the next day. */
export function localDay(now: Date | number = Date.now()): string {
  const at = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function showWslBanner(input: { nativeWindows: boolean; dismissedDay: string | null; now?: Date }): boolean {
  return input.nativeWindows && input.dismissedDay !== localDay(input.now);
}
