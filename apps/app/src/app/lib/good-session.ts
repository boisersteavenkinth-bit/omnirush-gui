// "Good session ★": the live checklist the session view shows, worked out
// locally from the session's own tool events. The server's strict check has
// the final say (omnirush-backend: session_repro.py, the Session QC V2 gate
// and quality_rewards.STRICT_SPINS_TEXT); these rules mirror the parts of it
// a turn can see as it runs:
//
//   code     at least one project code file changed (session_qc.is_code_path)
//   ran      the agent ran something: a build, the tests or the program
//            (session_qc.BUILD_TEST, plus running the program itself)
//   project  the work stays inside the project folder (V3 outside_path,
//            home_folder), with no personal services (V3 remote_service,
//            local_database, remote_git, docker)
//   finished the last turn finished (V3 unrecorded_turn, V2 `finished`)
//   windows  not native Windows (V3 windows_host); WSL is fine
//
// Sub-agents and many turns are not required.

import type { UIMessage } from "ai";

export const GOOD_SESSION_LABEL = "Good session ★";

/** The four steps the rewards panel and the checklist's link show. */
export const GOOD_SESSION_GUIDE: readonly string[] = [
  "Work inside your project folder.",
  "Build or change real code.",
  "Run it or its tests.",
  "Let the last turn finish.",
];
export const GOOD_SESSION_WSL_TIP = "On Windows? Use WSL.";
export const GOOD_SESSION_GUIDE_LINK = "How to make a Good session";

/** The console's WSL guide (omnirush-console app/console/wsl, lib/wsl-guide). */
export const WSL_GUIDE_URL = "https://omnirush.ai/console/wsl";
export const WSL_BANNER_TEXT = "Sessions from native Windows don't count as Good sessions. Switch to WSL";

export const TURN_GUARD_TITLE = "A turn is still running.";
export const TURN_GUARD_DETAIL = "Quit now and this session won't count as a Good session ★.";
export const TURN_GUARD_MESSAGE = `${TURN_GUARD_TITLE} ${TURN_GUARD_DETAIL}`;
export const TURN_GUARD_WAIT = "Wait for it";
export const TURN_GUARD_QUIT = "Quit anyway";

/**
 * Server texts still say "replay-ready ★" (STRICT_SPINS_TEXT, notices,
 * hints): users read "Good session ★" everywhere.
 */
export function goodSessionWording(text: string): string;
export function goodSessionWording(text: string | null | undefined): string | null | undefined;
export function goodSessionWording(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text
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

function normPath(path: string): string {
  let norm = path.replace(/\\/g, "/").toLowerCase();
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
export function isCodePath(path: string): boolean {
  const norm = normPath(path.trim());
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

// --- Commands (session_qc.BUILD_TEST, session_qc_v2._runs) --------------------

/** A build, a test run or a linter/type check (session_qc.BUILD_TEST). */
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
/** Running the program itself: a script, a dev server, the built binary. */
const PROGRAM_RUN = new RegExp(
  String.raw`^(`
  + String.raw`(node|deno|bun|tsx|ts-node)( run)? [^-\s]\S*|`
  + String.raw`python[\d.]* (-m \S+|[^-\s]\S*\.py\b)|uv run|poetry run|`
  + String.raw`(npm|pnpm|yarn|bun) (run )?(start|dev|serve|preview|test|build)\b|npm run \S+|npx \S+|`
  + String.raw`go run|cargo run|dotnet run|swift run|mvn exec|gradle run|\./gradlew|`
  + String.raw`(bash|sh|zsh) [^-\s]\S*\.sh\b|ruby \S+\.rb\b|php \S+\.php\b|perl \S+\.pl\b|java (-jar )?\S+|`
  + String.raw`uvicorn|gunicorn|flask run|rails (s|server|test)\b|rake\b|bundle exec|`
  + String.raw`\.{1,2}/\S+|(\S+/)?(bin|build|target|dist|out)/\S+`
  + String.raw`)`,
  "i",
);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const WRAPPERS = new Set(["sudo", "time", "nice", "env", "exec", "command", "timeout"]);

/** The commands of a shell line, each as its words (V2 `_split`/`_words`). */
export function commandSegments(command: string): string[][] {
  return command
    .split(/\n|&&|\|\||;|\||\(|\)|`|\$\(/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      while (words.length) {
        const first = words[0]!;
        if (ENV_ASSIGN.test(first)) { words.shift(); continue; }
        if (WRAPPERS.has(first)) {
          words.shift();
          if (first === "timeout" && /^\d/.test(words[0] ?? "")) words.shift();
          continue;
        }
        break;
      }
      return words;
    })
    .filter((words) => words.length > 0);
}

/** Whether a shell line builds, tests or runs the program. */
export function ranSomething(command: string): boolean {
  return commandSegments(command).some((words) => {
    const line = words.join(" ");
    return BUILD_TEST.test(line) || PROGRAM_RUN.test(line);
  });
}

const REMOTE_PROGRAMS = new Set([
  "gh", "glab", "ssh", "scp", "sftp", "aws", "gcloud", "az", "vercel", "netlify", "firebase",
  "supabase", "wrangler", "flyctl", "fly", "heroku", "railway", "kubectl", "helm", "terraform",
  "doctl", "ngrok", "cloudflared", "gsutil", "eas",
]);
const DB_CLIENTS = new Set(["psql", "pgcli", "mysql", "mariadb", "mycli", "mongosh", "mongo", "redis-cli"]);
const DOCKER_PROGRAMS = new Set(["docker", "docker-compose", "podman"]);
const PROBE_ARGS = new Set(["--help", "--version", "--dry-run", "--dryrun", "-h", "-v"]);
const GIT_REMOTE = /\bgit\s+(-C\s+\S+\s+)?(clone|fetch|pull|push|ls-remote)\b/;
const DB_SETUP = /createdb|create\s+database|initdb|\bmigrate\b|db:migrate|db\s+push|alembic\s+upgrade|drizzle-kit\s+(push|migrate)|\bseed\b|db:seed/i;
const QUOTED = /'[^']*'|"[^"]*"/g;

/** The personal service a shell line uses (V3 remote_service, local_database, remote_git, docker), or null. */
export function personalService(command: string, options: { dbBuilt?: boolean } = {}): string | null {
  const bare = command.replace(QUOTED, " ");
  if (GIT_REMOTE.test(bare)) return "a remote git repository";
  for (const words of commandSegments(bare)) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    if (words.slice(1).some((word) => PROBE_ARGS.has(word))) continue;
    if (REMOTE_PROGRAMS.has(program)) return program;
    if (DOCKER_PROGRAMS.has(program)) return "docker";
    if (DB_CLIENTS.has(program) && !options.dbBuilt) return program;
  }
  return null;
}

// --- Folders ---------------------------------------------------------------

const HOME_FOLDER = /^(\/home\/[^/]+|\/users\/[^/]+|\/root|[a-z]:\/users\/[^/]+|~)\/?$/;

function folderKey(path: string): string {
  return normPath(path.trim()).replace(/\/+$/, "");
}

/** The project folder is the home folder itself (V3 home_folder). */
export function isHomeFolder(root: string): boolean {
  return HOME_FOLDER.test(folderKey(root));
}

function isAbsolute(norm: string): boolean {
  return norm.startsWith("/") || norm.startsWith("~") || WINDOWS_DRIVE.test(norm);
}

/** Whether a path the agent changed or worked in is outside the project folder (scratch folders are fine). */
export function outsideProject(path: string, root: string): boolean {
  let norm = folderKey(path);
  const base = folderKey(root);
  if (!norm || !base) return false;
  if (!isAbsolute(norm)) {
    // Relative to the project folder: only `..` can leave it.
    if (!norm.split("/").includes("..")) return false;
    norm = resolveDots(`${base}/${norm}`);
  }
  if (isScratch(`${norm}/`)) return false;
  return norm !== base && !norm.startsWith(`${base}/`);
}

function resolveDots(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (out.length > 1) out.pop();
    } else if (segment !== "." && (segment || out.length === 0)) {
      out.push(segment);
    }
  }
  return out.join("/");
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

export type GoodSessionChecklist = {
  checks: GoodSessionCheck[];
  /** Every check passes: the session can earn a Good session ★. */
  good: boolean;
  /** The checks that still fail, without the running turn. */
  missing: GoodSessionCheck[];
  /** "Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn". */
  text: string;
};

export type GoodSessionInput = {
  messages: readonly UIMessage[];
  /** The project folder the session runs in. */
  workspaceRoot: string;
  /** A turn is running (busy, retrying, waiting on a question or a permission). */
  turnRunning: boolean;
  /** Native Windows (not WSL). */
  nativeWindows: boolean;
};

const EDIT_TOOLS = new Set([
  "edit", "write", "patch", "multiedit", "apply_patch", "str_replace", "str_replace_editor", "create", "notebookedit",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "run", "exec", "terminal", "execute", "bash_output"]);
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

type ToolCall = { tool: string; input: Record<string, unknown>; state: string; failed: boolean; notRun: boolean };

/** A call the engine or the user refused, so nothing ran (bad arguments, an unknown tool, a denied permission). */
const NOT_RUN = /invalid arguments|no tool named|unknown tool|tool .{0,40}not (found|available)|permission .{0,20}(denied|rejected)|user (rejected|denied|dismissed)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toolCalls(message: UIMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of message.parts) {
    const record = part as unknown as Record<string, unknown>;
    let tool = "";
    if (part.type === "dynamic-tool") tool = str(record.toolName);
    else if (part.type.startsWith("tool-")) tool = part.type.slice(5);
    else continue;
    const failed = record.state === "output-error";
    calls.push({
      tool: tool.toLowerCase().replace(/^.*[.:]/, ""),
      input: isRecord(record.input) ? record.input : {},
      state: str(record.state),
      failed,
      notRun: failed && NOT_RUN.test(str(record.errorText)),
    });
  }
  return calls;
}

/** The files an edit tool changed: its path field, or the files its patch names. */
export function editedPaths(input: Record<string, unknown>): string[] {
  const direct = str(input.filePath) || str(input.file_path) || str(input.path) || str(input.file) || str(input.target_file);
  if (direct) return [direct];
  const patch = str(input.patchText) || str(input.patch) || str(input.input);
  const paths: string[] = [];
  for (const match of patch.matchAll(PATCH_FILE)) {
    const path = (match[1] ?? match[2] ?? "").trim();
    if (path) paths.push(path);
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

function sessionErrorOf(message: UIMessage): boolean {
  return message.parts.some((part) => {
    const metadata = (part as { providerMetadata?: unknown }).providerMetadata;
    return isRecord(metadata) && isRecord(metadata.opencode) && metadata.opencode.sessionError !== undefined;
  });
}

function lastTurnState(messages: readonly UIMessage[], turnRunning: boolean): GoodSessionCheckState | "cut" {
  if (turnRunning) return "pending";
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "cut";
  if (sessionErrorOf(last)) return "cut";
  const unfinished = toolCalls(last).some((call) => call.state === "input-streaming" || call.state === "input-available");
  return unfinished ? "cut" : "pass";
}

/** The checklist for a session, from its transcript. */
export function goodSessionChecklist(input: GoodSessionInput): GoodSessionChecklist {
  let code = false;
  let ran = false;
  let outside: string | null = null;
  let service: string | null = null;
  const home = input.workspaceRoot.trim() ? isHomeFolder(input.workspaceRoot) : false;
  const calls = input.messages.filter((message) => message.role === "assistant").flatMap(toolCalls);
  const dbBuilt = calls.some((call) => SHELL_TOOLS.has(call.tool) && DB_SETUP.test(shellCommand(call.input)));

  for (const call of calls) {
    if (call.notRun) continue;
    if (EDIT_TOOLS.has(call.tool)) {
      for (const path of editedPaths(call.input)) {
        if (outsideProject(path, input.workspaceRoot)) {
          outside ??= path;
          continue;
        }
        if (!call.failed && isCodePath(path)) code = true;
      }
    } else if (SHELL_TOOLS.has(call.tool)) {
      const command = shellCommand(call.input);
      if (!command) continue;
      if (ranSomething(command)) ran = true;
      service ??= personalService(command, { dbBuilt });
      for (const folder of shellFolders(command, call.input)) {
        if (outsideProject(folder, input.workspaceRoot)) outside ??= folder;
      }
    }
  }

  const finished = lastTurnState(input.messages, input.turnRunning);
  const checks: GoodSessionCheck[] = [
    {
      id: "code",
      state: code ? "pass" : "fail",
      label: "code changed",
      hint: code ? "A project code file changed." : "Build or change real code in the project.",
    },
    {
      id: "ran",
      state: ran ? "pass" : "fail",
      label: "ran/tested",
      hint: ran ? "The agent ran a build, the tests or the program." : "Ask the agent to run it or its tests.",
    },
    {
      id: "project",
      state: home || outside || service ? "fail" : "pass",
      label: "in project",
      hint: home
        ? "The session runs in your home folder: open a project folder instead."
        : outside
          ? `Work outside the project folder: ${outside}`
          : service
            ? `Uses a personal service (${service}): keep the work inside the project.`
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
  if (input.nativeWindows) {
    checks.push({ id: "windows", state: "fail", label: "native Windows", hint: "Sessions from native Windows don't count: use WSL." });
  }
  const missing = checks.filter((check) => check.state === "fail");
  const good = checks.every((check) => check.state === "pass");
  return { checks, good, missing, text: checklistText(checks, good) };
}

function mark(check: GoodSessionCheck): string {
  if (check.state === "pending") return check.label;
  return `${check.label} ${check.state === "pass" ? "✓" : "✗"}`;
}

export function checklistText(checks: readonly GoodSessionCheck[], good = checks.every((check) => check.state === "pass")): string {
  return `${good ? GOOD_SESSION_LABEL : "Good session"}: ${checks.map(mark).join(" · ")}`;
}

/** The one gentle nudge after a turn ends with something missing, or null. */
export function goodSessionNudge(checklist: GoodSessionChecklist): { title: string; body: string } | null {
  const missing = checklist.missing;
  if (!missing.length) return null;
  return {
    title: `Not a ${GOOD_SESSION_LABEL} yet`,
    body: missing.map((check) => check.hint).join(" "),
  };
}

/**
 * When to nudge: once per session, on the turn that just ended (running →
 * not running), and only when something is missing.
 */
export function shouldNudge(input: {
  wasRunning: boolean;
  running: boolean;
  checklist: GoodSessionChecklist;
  alreadyNudged: boolean;
}): boolean {
  return input.wasRunning && !input.running && !input.alreadyNudged && input.checklist.missing.length > 0;
}

// --- The don't-quit-mid-turn guard --------------------------------------------

export type TurnGuardAction = "close" | "quit" | "switch" | "delete";

/** Whether leaving (closing, quitting, switching or deleting) needs the confirm first. */
export function needsTurnGuard(input: { action: TurnGuardAction; turnRunning: boolean; targetSessionId?: string | null; currentSessionId?: string | null }): boolean {
  if (!input.turnRunning) return false;
  if (input.action === "switch") {
    return Boolean(input.currentSessionId) && input.targetSessionId !== input.currentSessionId;
  }
  return true;
}

// --- Native Windows ------------------------------------------------------------

export const WSL_BANNER_DISMISSED_KEY = "omnirush.goodSession.wslBannerDismissedDay.v1";

/** The local day ("2026-10-06"): a dismissed banner comes back the next day. */
export function localDay(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function showWslBanner(input: { nativeWindows: boolean; dismissedDay: string | null; now?: Date }): boolean {
  return input.nativeWindows && input.dismissedDay !== localDay(input.now);
}
