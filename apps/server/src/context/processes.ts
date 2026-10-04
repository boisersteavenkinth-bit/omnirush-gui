// #19 Listening TCP ports (with the owning process) and the running
// development processes (name + command line, arguments scrubbed, never the
// environment), at session start and at each turn start. Linux reads /proc
// (no spawn) plus `ss -Hltnp` for the port owners; macOS `ps` and `lsof`;
// Windows `netstat -ano` and one PowerShell CIM query.

import { readdir, readFile, readlink } from "node:fs/promises";

import { runTool, type Runner } from "./exec.js";
import { addressClass, cleanText, type PrivacyContext, type Scrubber } from "./privacy.js";

export const MAX_PROCESSES = 200;
export const MAX_LISTENING = 200;
const MAX_COMMAND_CHARS = 2_000;

export type ProcessInfo = { pid: number; ppid: number; name: string; command: string };
export type ListeningPort = { proto: "tcp"; address: string; port: number; pid: number | null; process: string | null };

/** Process names (or name prefixes) that matter to a developer's environment. */
const DEV_NAMES = [
  "node", "nodejs", "deno", "bun", "npm", "npx", "pnpm", "yarn", "tsx", "ts-node", "vite", "next", "nuxt", "webpack", "esbuild", "turbo",
  "python", "python2", "python3", "pypy", "uvicorn", "gunicorn", "hypercorn", "celery", "flask", "django", "jupyter", "ipython", "uv", "poetry",
  "java", "javaw", "kotlin", "gradle", "gradlew", "mvn", "sbt", "ruby", "rails", "puma", "unicorn", "sidekiq", "bundle", "irb",
  "go", "gopls", "air", "dlv", "cargo", "rustc", "rust-analyzer", "php", "php-fpm", "composer", "dotnet", "elixir", "beam.smp", "erl", "mix",
  "docker", "dockerd", "containerd", "containerd-shim", "docker-proxy", "com.docker.backend", "podman", "kubectl", "minikube", "kind", "k3s", "colima", "lima",
  "postgres", "postmaster", "mysqld", "mariadbd", "mongod", "mongos", "redis-server", "valkey-server", "memcached", "elasticsearch", "opensearch",
  "rabbitmq-server", "kafka", "zookeeper", "clickhouse", "clickhouse-server", "cockroach", "neo4j", "influxd", "etcd", "minio", "sqlservr", "oracle",
  "nginx", "httpd", "apache2", "caddy", "traefik", "envoy", "haproxy", "ollama", "localstack", "mailhog", "mailpit",
  "make", "cmake", "ninja", "bazel", "gcc", "clang", "lldb", "gdb", "playwright", "chromedriver", "geckodriver",
];
const DEV_NAME_SET = new Set(DEV_NAMES);

function baseName(raw: string): string {
  const name = raw.split(/[\\/]/).at(-1) ?? raw;
  return name.replace(/\.exe$/i, "").toLowerCase();
}

/** Whether a process is a development tool, runtime, database or server (by name, or by its interpreter's script). */
export function isDevProcess(name: string, command = ""): boolean {
  const base = baseName(name);
  if (DEV_NAME_SET.has(base)) return true;
  if (/^(?:python|pypy)\d+(?:\.\d+)*$/.test(base) || /^node\d*$/.test(base) || /^java\d*$/.test(base) || /^ruby\d+(?:\.\d+)*$/.test(base) || /^php\d+(?:\.\d+)*$/.test(base)) return true;
  if (/^postgres:|^postgres$/.test(base)) return true;
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first !== "" && DEV_NAME_SET.has(baseName(first));
}

/** The engine and app processes capture itself runs (their command lines carry loopback secrets). */
function isOwnProcess(info: ProcessInfo, selfPid: number): boolean {
  if (info.pid === selfPid) return true;
  return /\b(?:opencode|omnirush-engine|omnirush-server)\b.*\bserve\b/i.test(info.command);
}

/** A command line for the record: home as `~`, URL userinfo dropped, secrets scrubbed, at most 2000 chars. */
export function cleanCommand(command: string, privacy: PrivacyContext, scrub: Scrubber): string {
  const flat = command.replace(/\s+/g, " ").trim();
  // `--token value` / `--password=value`: the value after a secret-named flag goes, whatever it looks like.
  const flagged = flat
    .replace(/(--?[\w-]*(?:token|password|passwd|secret|api[-_]?key|auth|credential)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]");
  const cleaned = cleanText(flagged, privacy, scrub);
  return cleaned.length > MAX_COMMAND_CHARS ? `${cleaned.slice(0, MAX_COMMAND_CHARS)}…` : cleaned;
}

// --- Linux ------------------------------------------------------------------------

/** /proc/<pid>/stat: comm (between the outer parentheses) and the parent pid. */
export function parseProcStat(text: string): { comm: string; ppid: number; startTicks: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isInteger(ppid)) return null;
  return { comm: text.slice(open + 1, close), ppid, startTicks: Number.isFinite(startTicks) ? startTicks : 0 };
}

export async function linuxProcesses(procRoot = "/proc"): Promise<ProcessInfo[]> {
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const out: ProcessInfo[] = [];
  await Promise.all(names.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    try {
      const [stat, cmdline] = await Promise.all([
        readFile(`${procRoot}/${name}/stat`, "utf8"),
        readFile(`${procRoot}/${name}/cmdline`).catch(() => Buffer.alloc(0)),
      ]);
      const parsed = parseProcStat(stat);
      if (!parsed) return;
      const command = cmdline.toString("utf8").replace(/\0+$/, "").split("\0").join(" ");
      out.push({ pid: Number(name), ppid: parsed.ppid, name: parsed.comm, command: command || `[${parsed.comm}]` });
    } catch {
      // Gone or not ours.
    }
  }));
  return out.sort((a, b) => a.pid - b.pid);
}

/** An address of /proc/net/tcp{,6} (little-endian hex) as text. */
export function parseProcAddress(hex: string): { address: string; port: number } | null {
  const [ip, port] = hex.split(":");
  if (!ip || !port) return null;
  const portNumber = parseInt(port, 16);
  if (ip.length === 8) {
    const bytes = [0, 1, 2, 3].map((i) => parseInt(ip.slice(i * 2, i * 2 + 2), 16)).reverse();
    return { address: bytes.join("."), port: portNumber };
  }
  if (ip.length === 32) {
    const words: string[] = [];
    for (let w = 0; w < 4; w += 1) {
      const chunk = ip.slice(w * 8, w * 8 + 8);
      const bytes = [0, 1, 2, 3].map((i) => chunk.slice(i * 2, i * 2 + 2)).reverse().join("");
      words.push(bytes.slice(0, 4), bytes.slice(4, 8));
    }
    const groups = words.map((word) => word.replace(/^0+(?=.)/, "").toLowerCase());
    let address = groups.join(":");
    if (address.startsWith("0:0:0:0:0:ffff:")) {
      const v4 = ip.slice(24);
      address = [0, 1, 2, 3].map((i) => parseInt(v4.slice(i * 2, i * 2 + 2), 16)).reverse().join(".");
    } else {
      address = address.replace(/(^|:)0(:0)+(:|$)/, "::").replace(/:{3,}/, "::");
    }
    return { address, port: portNumber };
  }
  return null;
}

export type ProcSocket = { local: { address: string; port: number }; remote: { address: string; port: number }; state: string; inode: number };

/** The rows of /proc/net/tcp or tcp6. */
export function parseProcNetTcp(text: string): ProcSocket[] {
  const out: ProcSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = parseProcAddress(fields[1]!);
    const remote = parseProcAddress(fields[2]!);
    if (!local || !remote) continue;
    out.push({ local, remote, state: fields[3]!, inode: Number(fields[9]) });
  }
  return out;
}

export async function readProcSockets(procNet = "/proc/net"): Promise<ProcSocket[]> {
  const files = await Promise.all(["tcp", "tcp6"].map((name) => readFile(`${procNet}/${name}`, "utf8").catch(() => "")));
  return files.flatMap(parseProcNetTcp);
}

/** Socket inode -> pid for the given processes (only those whose fds are readable: the user's own). */
export async function socketOwners(pids: readonly number[], procRoot = "/proc"): Promise<Map<number, number>> {
  const owners = new Map<number, number>();
  await Promise.all(pids.map(async (pid) => {
    let fds: string[];
    try {
      fds = await readdir(`${procRoot}/${pid}/fd`);
    } catch {
      return;
    }
    await Promise.all(fds.slice(0, 4096).map(async (fd) => {
      try {
        const target = await readlink(`${procRoot}/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) owners.set(Number(match[1]), pid);
      } catch {
        // Closed meanwhile.
      }
    }));
  }));
  return owners;
}

/** `ss -Hltnp` rows: `LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=12,fd=6))`. */
export function parseSsListening(text: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields.find((field, index) => index >= 3 && /:\d+$/.test(field));
    if (!local) continue;
    const at = local.lastIndexOf(":");
    const address = local.slice(0, at).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const port = Number(local.slice(at + 1));
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push({ proto: "tcp", address, port, pid: users ? Number(users[2]) : null, process: users ? users[1]! : null });
  }
  return out;
}

async function linuxListening(processes: ProcessInfo[], run?: Runner): Promise<{ ports: ListeningPort[]; method: string }> {
  const ss = await runTool("ss", ["-Hltnp"], { timeoutMs: 3_000, maxBytes: 512 * 1024, ...(run ? { run } : {}) });
  if (ss && ss.code === 0 && ss.stdout.trim()) return { ports: parseSsListening(ss.stdout), method: "ss" };
  const sockets = (await readProcSockets()).filter((socket) => socket.state === "0A");
  const owners = await socketOwners(processes.map((p) => p.pid));
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  return {
    method: "proc",
    ports: sockets.map((socket) => {
      const pid = owners.get(socket.inode) ?? null;
      return { proto: "tcp" as const, address: socket.local.address, port: socket.local.port, pid, process: pid !== null ? byPid.get(pid)?.name ?? null : null };
    }),
  };
}

// --- macOS --------------------------------------------------------------------------

/** `ps -axww -o pid=,ppid=,comm=,args=`: comm is the executable path on macOS. */
export function parsePs(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const rest = match[3]!;
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), name: baseName(rest.split(/\s+/)[0] ?? ""), command: rest.trim() });
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: p<pid>, c<command>, n<addr:port> fields. */
export function parseLsofListen(text: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) {
      const value = line.slice(1).split("->")[0]!;
      const at = value.lastIndexOf(":");
      if (at < 0) continue;
      const address = value.slice(0, at).replace(/^\[|\]$/g, "");
      out.push({ proto: "tcp", address: address === "*" ? "0.0.0.0" : address, port: Number(value.slice(at + 1)), pid, process: command });
    }
  }
  return out;
}

// --- Windows ------------------------------------------------------------------------

/** `netstat -ano -p TCP` LISTENING rows (and both families with -p TCPv6). */
export function parseNetstat(text: string, state = "LISTENING"): Array<{ local: string; remote: string; pid: number }> {
  const out: Array<{ local: string; remote: string; pid: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !/^TCP/i.test(fields[0]!)) continue;
    if (fields[3]!.toUpperCase() !== state) continue;
    out.push({ local: fields[1]!, remote: fields[2]!, pid: Number(fields[4]) });
  }
  return out;
}

export function splitHostPort(value: string): { address: string; port: number } | null {
  const at = value.lastIndexOf(":");
  if (at < 0) return null;
  return { address: value.slice(0, at).replace(/^\[|\]$/g, "").replace(/%.*$/, ""), port: Number(value.slice(at + 1)) };
}

const WINDOWS_PROCESS_QUERY =
  "$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
  + "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";

export function parseWindowsProcesses(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, name, ...command] = line.split("\t");
    if (!pid || !/^\d+$/.test(pid)) continue;
    out.push({ pid: Number(pid), ppid: Number(ppid) || 0, name: name ?? "", command: command.join("\t") || name || "" });
  }
  return out;
}

// --- all platforms --------------------------------------------------------------------

export type ProcessTableOptions = { platform?: NodeJS.Platform; run?: Runner };

/** Every process visible to the user: pid, parent, name and command line. */
export async function processTable(options: ProcessTableOptions = {}): Promise<{ processes: ProcessInfo[]; method: string }> {
  const platform = options.platform ?? process.platform;
  const runOpt = options.run ? { run: options.run } : {};
  if (platform === "linux") return { processes: await linuxProcesses(), method: "proc" };
  if (platform === "win32") {
    const result = await runTool("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY], { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024, ...runOpt });
    return { processes: result && result.code === 0 ? parseWindowsProcesses(result.stdout) : [], method: "powershell" };
  }
  const result = await runTool("ps", ["-axww", "-o", "pid=,ppid=,args="], { timeoutMs: 5_000, maxBytes: 4 * 1024 * 1024, ...runOpt });
  return { processes: result && result.code === 0 ? parsePs(result.stdout) : [], method: "ps" };
}

export async function listeningPorts(processes: ProcessInfo[], options: ProcessTableOptions = {}): Promise<{ ports: ListeningPort[]; method: string }> {
  const platform = options.platform ?? process.platform;
  const runOpt = options.run ? { run: options.run } : {};
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  let ports: ListeningPort[] = [];
  let method = "none";
  if (platform === "linux") {
    ({ ports, method } = await linuxListening(processes, options.run));
  } else if (platform === "win32") {
    const result = await runTool("netstat", ["-ano", "-p", "TCP"], { timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024, ...runOpt });
    const v6 = await runTool("netstat", ["-ano", "-p", "TCPv6"], { timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024, ...runOpt });
    method = "netstat";
    for (const row of [...parseNetstat(result?.stdout ?? ""), ...parseNetstat(v6?.stdout ?? "")]) {
      const local = splitHostPort(row.local);
      if (local) ports.push({ proto: "tcp", ...local, pid: row.pid, process: byPid.get(row.pid)?.name ?? null });
    }
  } else {
    const result = await runTool("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024, ...runOpt });
    method = "lsof";
    ports = parseLsofListen(result?.stdout ?? "");
  }
  // One row per (address, port), filled in from the process table.
  const seen = new Set<string>();
  const out: ListeningPort[] = [];
  for (const port of ports.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address))) {
    const key = `${port.address}|${port.port}`;
    if (seen.has(key) || !Number.isInteger(port.port) || port.port <= 0) continue;
    seen.add(key);
    out.push({ ...port, process: port.process ?? (port.pid !== null ? byPid.get(port.pid)?.name ?? null : null) });
  }
  return { ports: out, method };
}

/** A listening port of a process outside the session: its port and the process's base name, nothing else. */
export type ForeignListeningPort = { proto: "tcp"; port: number; process: string | null };

export type ProcessSnapshot = {
  phase: "session_start" | "turn_start";
  turn: number;
  collected_at: string;
  /** Ports of the session's processes (address class, pid, name) and of any other process (port and base name only). */
  listening: Array<ListeningPort | ForeignListeningPort>;
  /** The session's own processes and those working in its folders, with scrubbed command lines. */
  processes: Array<{ pid: number; name: string; command: string; scope: "session" | "folder" }>;
  /** How many processes the machine runs (none of the others is named). */
  total_processes: number;
  truncated: boolean;
  method: string;
};

/** Which processes belong to the session: the app's process tree, and processes working in the session's folders. */
export type SnapshotScope = {
  /** The app's process (the CLI, or the desktop server): the session's tree is its descendants. */
  rootPid: number;
  /** The project and the outside folders the agent created or worked in (absolute). */
  folders: () => readonly string[];
};

export type SnapshotOptions = ProcessTableOptions & {
  privacy: PrivacyContext;
  scrub: Scrubber;
  selfPid?: number;
  now?: () => Date;
  /** A process table and port list already taken (session start shares them with services). */
  precomputed?: { processes: ProcessInfo[]; listening: ListeningPort[]; method?: string };
  scope?: SnapshotScope;
  /** Tests: the working directory of a process (Linux /proc, macOS lsof), null when unknown. */
  cwdOf?: (pids: number[]) => Promise<Map<number, string>>;
};

/** The descendants of `rootPid` in a process table. */
export function descendantsOf(rootPid: number, processes: readonly ProcessInfo[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const info of processes) {
    const list = children.get(info.ppid) ?? [];
    list.push(info.pid);
    children.set(info.ppid, list);
  }
  const out = new Set<number>();
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0 && out.size < 100_000) {
    const pid = queue.shift()!;
    if (out.has(pid)) continue;
    out.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** The working directories of `pids`: /proc/<pid>/cwd on Linux, `lsof -d cwd` on macOS, none on Windows. */
export async function processCwds(pids: number[], options: ProcessTableOptions = {}): Promise<Map<number, string>> {
  const platform = options.platform ?? process.platform;
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (platform === "linux") {
    await Promise.all(pids.map(async (pid) => {
      try {
        out.set(pid, await readlink(`/proc/${pid}/cwd`));
      } catch {
        // Another account's process, or gone.
      }
    }));
    return out;
  }
  if (platform === "darwin") {
    const result = await runTool("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.slice(0, 500).join(",")], { timeoutMs: 4_000, maxBytes: 1024 * 1024, ...(options.run ? { run: options.run } : {}) });
    let pid = 0;
    for (const line of result?.stdout.split(/\r?\n/) ?? []) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
    }
  }
  return out;
}

function insideAny(path: string, folders: readonly string[]): boolean {
  const portable = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return folders.some((folder) => {
    const base = folder.replaceAll("\\", "/").replace(/\/+$/, "");
    return base.length > 1 && (portable === base || portable.startsWith(`${base}/`));
  });
}

function baseNameOnly(name: string | null): string | null {
  if (!name) return null;
  const base = name.trim().split(/\s+/)[0]!.split(/[\\/]/).at(-1) ?? "";
  return base.replace(/[^\w.+-]/g, "").slice(0, 64) || null;
}

/**
 * One #19 snapshot. Only the session's own processes (descendants of the
 * app's process) and processes working inside the project or an outside
 * folder of the session are listed, with their scrubbed command lines. Any
 * other process on the machine is never named, except as the owner of a
 * listening port, shown as the port and the process's base name only.
 */
export async function processSnapshot(phase: ProcessSnapshot["phase"], turn: number, options: SnapshotOptions): Promise<ProcessSnapshot> {
  const { processes, method } = options.precomputed ? { processes: options.precomputed.processes, method: options.precomputed.method ?? "shared" } : await processTable(options);
  const { ports, method: portMethod } = options.precomputed ? { ports: options.precomputed.listening, method: "shared" } : await listeningPorts(processes, options);
  const self = options.selfPid ?? process.pid;
  const scope = options.scope ?? { rootPid: self, folders: () => [] };
  const tree = descendantsOf(scope.rootPid, processes);
  const folders = scope.folders();
  const others = processes.filter((info) => !tree.has(info.pid) && info.pid !== scope.rootPid);
  const cwds = folders.length > 0 ? await (options.cwdOf ?? ((pids) => processCwds(pids, options)))(others.map((info) => info.pid)).catch(() => new Map<number, string>()) : new Map<number, string>();
  const inFolders = new Set(others.filter((info) => {
    const cwd = cwds.get(info.pid);
    return cwd !== undefined && insideAny(cwd, folders);
  }).map((info) => info.pid));
  const ours = processes.filter((info) => (tree.has(info.pid) || inFolders.has(info.pid)) && !isOwnProcess(info, self));
  const kept = ours.slice(0, MAX_PROCESSES).map((info) => ({
    pid: info.pid,
    name: cleanText(baseNameOnly(info.name) ?? info.name, options.privacy, options.scrub),
    command: cleanCommand(info.command, options.privacy, options.scrub),
    scope: tree.has(info.pid) ? ("session" as const) : ("folder" as const),
  }));
  const owned = (pid: number | null) => pid !== null && (tree.has(pid) || inFolders.has(pid) || pid === scope.rootPid);
  const listening = ports.slice(0, MAX_LISTENING).map((port): ListeningPort | ForeignListeningPort => (owned(port.pid)
    ? { ...port, address: addressClass(port.address), process: port.process ? cleanText(baseNameOnly(port.process) ?? port.process, options.privacy, options.scrub) : null }
    : { proto: "tcp", port: port.port, process: baseNameOnly(port.process) }));
  return {
    phase,
    turn,
    collected_at: (options.now ?? (() => new Date()))().toISOString(),
    listening,
    processes: kept,
    total_processes: processes.length,
    truncated: ours.length > MAX_PROCESSES || ports.length > MAX_LISTENING,
    method: options.precomputed ? method : `${method}+${portMethod}`,
  };
}
