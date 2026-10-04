// #20 The network hosts each shell tool call reached. While a turn runs, a
// cheap observer samples the app's process tree: every shell the engine
// starts for a tool call (`<shell> -c <command>`) is a tool root, and the
// TCP connections of the root and its descendants are recorded.
//
//   Linux:   /proc/<pid>/task/*/children for the tree, /proc/<pid>/fd socket
//            inodes matched against /proc/net/tcp{,6}; no process is spawned.
//   macOS:   `ps` for the tree and `lsof -nP -a -iTCP -p <pids>` for the
//            connections, only while a tool shell is running.
//   Windows: one PowerShell CIM query for the tree and `netstat -ano`.
//
// After the turn each root is matched to the tool call that ran its
// command (and started within its time); connections of a root no call
// matches are recorded for the whole turn (`scope: "turn"`). Sampling
// misses a connection shorter than the poll interval. Hosts are named from
// the hostnames in the command (resolved with the system resolver, so the
// same DNS answers the tool saw, usually from cache), else by reverse DNS
// with a short timeout. Raw IP addresses are never recorded, only their
// class. OMNIRUSH_CAPTURE_NETWORK=0 turns the observer off.

import { promises as dns } from "node:dns";
import { readdir, readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

import type { ToolCall } from "./commands.js";
import { runTool, type Runner } from "./exec.js";
import { addressClass, type AddressClass } from "./privacy.js";
import { parseNetstat, parsePs, parseProcNetTcp, parseProcStat, parseWindowsProcesses, splitHostPort, type ProcessInfo } from "./processes.js";

export const MAX_CONNECTIONS_PER_CALL = 100;
const MAX_ROOTS_PER_TURN = 500;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "busybox"]);

export type Connection = { host: string | null; port: number; address_class: AddressClass; resolved_by: "command" | "known_host" | "reverse" | "loopback" | null; first_seen: string };
export type NetworkEvent = {
  tool_call_id: string | null;
  tool: string;
  scope: "call" | "turn";
  turn: number;
  method: string;
  poll_ms: number;
  connections: Connection[];
  truncated: boolean;
};

type Seen = { ip: string; port: number; first: number };
type Root = { pid: number; command: string; firstSeen: number; connections: Map<string, Seen> };

/** The engine that runs the tools (`opencode serve`, the app's engine binary). */
export function isEngineProcess(argv: string[]): boolean {
  const line = argv.join(" ");
  return /(?:^|[\\/\s])(?:opencode|omnirush[-\w]*)(?:\.exe)?\b.*\bserve\b/i.test(line);
}

/** The command a tool shell runs: argv `[shell, …, -c, <command>]`, else null. */
export function shellCommandOf(argv: string[]): string | null {
  if (argv.length < 3) return null;
  const shell = (argv[0]!.split(/[\\/]/).at(-1) ?? "").replace(/\.exe$/i, "").toLowerCase();
  if (!SHELLS.has(shell)) return null;
  for (let i = 1; i < argv.length - 1; i += 1) {
    const flag = argv[i]!;
    if (/^-[a-z]*c$/i.test(flag) || /^-command$/i.test(flag) || /^\/c$/i.test(flag)) return argv.slice(i + 1).join(" ");
  }
  return null;
}

export type ProcSample = { pid: number; ppid: number; argv: string[] };
export type Sampler = {
  method: string;
  /** Interval between samples while no tool shell runs. */
  pollMs: number;
  /** Interval while a tool shell runs (short connections are only seen by a sample taken during them). */
  activePollMs?: number;
  /** Processes below `selfPid` (pid, parent, argv). */
  tree(selfPid: number): Promise<ProcSample[]>;
  /** Remote endpoints of the given processes' TCP connections. */
  connections(pids: number[]): Promise<Array<{ pid: number; ip: string; port: number }>>;
};

// --- Linux ---------------------------------------------------------------------------

async function linuxChildren(pid: number, procRoot: string): Promise<number[] | null> {
  let tasks: string[];
  try {
    tasks = await readdir(`${procRoot}/${pid}/task`);
  } catch {
    return [];
  }
  const out: number[] = [];
  let supported = false;
  await Promise.all(tasks.map(async (task) => {
    try {
      const text = await readFile(`${procRoot}/${pid}/task/${task}/children`, "utf8");
      supported = true;
      for (const child of text.trim().split(/\s+/)) if (child) out.push(Number(child));
    } catch {
      // No children file (kernel without CONFIG_PROC_CHILDREN) or the task ended.
    }
  }));
  return supported ? out : null;
}

export function linuxSampler(procRoot = "/proc", pollMs = 250, activePollMs = 100): Sampler {
  // Socket inode -> its remote endpoint (null: not a TCP socket with a peer, after a few looks).
  const known = new Map<number, { ip: string; port: number } | { misses: number }>();
  return {
    method: "proc",
    pollMs,
    activePollMs,
    async tree(selfPid) {
      const out: ProcSample[] = [];
      const readArgv = async (pid: number) => {
        try {
          const raw = await readFile(`${procRoot}/${pid}/cmdline`);
          return raw.toString("utf8").replace(/\0+$/, "").split("\0");
        } catch {
          return null;
        }
      };
      const queue: Array<{ pid: number; ppid: number }> = [];
      const first = await linuxChildren(selfPid, procRoot);
      if (first === null) {
        // Full scan: parent links from /proc/<pid>/stat.
        const parents = new Map<number, number>();
        for (const name of await readdir(procRoot).catch(() => [] as string[])) {
          if (!/^\d+$/.test(name)) continue;
          const stat = await readFile(`${procRoot}/${name}/stat`, "utf8").catch(() => null);
          const parsed = stat ? parseProcStat(stat) : null;
          if (parsed) parents.set(Number(name), parsed.ppid);
        }
        const below = new Set([selfPid]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const [pid, ppid] of parents) if (!below.has(pid) && below.has(ppid)) {
            below.add(pid);
            grew = true;
          }
        }
        for (const pid of below) if (pid !== selfPid) {
          const argv = await readArgv(pid);
          if (argv) out.push({ pid, ppid: parents.get(pid)!, argv });
        }
        return out;
      }
      for (const child of first) queue.push({ pid: child, ppid: selfPid });
      const seen = new Set<number>();
      while (queue.length > 0 && seen.size < 5_000) {
        const { pid, ppid } = queue.shift()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const argv = await readArgv(pid);
        if (!argv) continue;
        out.push({ pid, ppid, argv });
        for (const child of (await linuxChildren(pid, procRoot)) ?? []) queue.push({ pid: child, ppid: pid });
      }
      return out;
    },
    async connections(pids) {
      const owners = new Map<number, number>();
      await Promise.all(pids.map(async (pid) => {
        let fds: string[];
        try {
          fds = await readdir(`${procRoot}/${pid}/fd`);
        } catch {
          return;
        }
        await Promise.all(fds.slice(0, 2048).map(async (fd) => {
          try {
            const match = /^socket:\[(\d+)\]$/.exec(await readlink(`${procRoot}/${pid}/fd/${fd}`));
            if (match) owners.set(Number(match[1]), pid);
          } catch {
            // Closed.
          }
        }));
      }));
      if (owners.size === 0) return [];
      // The socket tables are read only when a socket appeared that is not known yet (cheap steady state).
      const unknown = [...owners.keys()].filter((inode) => {
        const entry = known.get(inode);
        return entry === undefined || ("misses" in entry && entry.misses < 3);
      });
      if (unknown.length > 0) {
        const found = new Set<number>();
        for (const name of ["tcp", "tcp6"]) {
          const text = await readFile(`${procRoot}/net/${name}`, "utf8").catch(() => "");
          for (const socket of parseProcNetTcp(text)) {
            if (!owners.has(socket.inode) || socket.state === "0A" || socket.remote.port === 0) continue;
            known.set(socket.inode, { ip: socket.remote.address, port: socket.remote.port });
            found.add(socket.inode);
          }
        }
        for (const inode of unknown) {
          if (found.has(inode)) continue;
          const entry = known.get(inode);
          known.set(inode, { misses: entry && "misses" in entry ? entry.misses + 1 : 1 });
        }
        if (known.size > 20_000) known.clear();
      }
      const out: Array<{ pid: number; ip: string; port: number }> = [];
      for (const [inode, pid] of owners) {
        const entry = known.get(inode);
        if (entry && "ip" in entry) out.push({ pid, ip: entry.ip, port: entry.port });
      }
      return out;
    },
  };
}

// --- macOS ---------------------------------------------------------------------------

/** `lsof -F pn` connection rows: `n10.0.0.2:51234->140.82.112.3:443`. */
export function parseLsofConnections(text: string): Array<{ pid: number; ip: string; port: number }> {
  const out: Array<{ pid: number; ip: string; port: number }> = [];
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && line.includes("->")) {
      const remote = splitHostPort(line.slice(1).split("->")[1]!.split(" ")[0]!);
      if (remote && remote.port > 0) out.push({ pid, ip: remote.address, port: remote.port });
    }
  }
  return out;
}

function descendantsOf(selfPid: number, processes: ProcessInfo[]): ProcSample[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes) {
    const list = children.get(info.ppid) ?? [];
    list.push(info);
    children.set(info.ppid, list);
  }
  const out: ProcSample[] = [];
  const queue = [...(children.get(selfPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const info = queue.shift()!;
    if (seen.has(info.pid)) continue;
    seen.add(info.pid);
    out.push({ pid: info.pid, ppid: info.ppid, argv: splitArgs(info.command) });
    queue.push(...(children.get(info.pid) ?? []));
  }
  return out;
}

/** A `ps args` / Windows CommandLine split back into words (quotes honoured; `-c` keeps the rest whole). */
export function splitArgs(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    const word = match[1] ?? match[2] ?? match[3]!;
    words.push(word);
    if (words.length >= 2 && /^(?:-[a-z]*c|-command|\/c)$/i.test(word) && SHELLS.has(basename(words[0]!).replace(/\.exe$/i, "").toLowerCase())) {
      words.push(command.slice(pattern.lastIndex).trim().replace(/^"(.*)"$/s, "$1"));
      break;
    }
  }
  return words;
}

export function macSampler(run?: Runner, pollMs = 1_000, activePollMs = 500): Sampler {
  const runOpt = run ? { run } : {};
  return {
    method: "lsof",
    pollMs,
    activePollMs,
    async tree(selfPid) {
      const result = await runTool("ps", ["-axww", "-o", "pid=,ppid=,args="], { timeoutMs: 3_000, maxBytes: 4 * 1024 * 1024, ...runOpt });
      return result && result.code === 0 ? descendantsOf(selfPid, parsePs(result.stdout)) : [];
    },
    async connections(pids) {
      if (pids.length === 0) return [];
      const result = await runTool("lsof", ["-nP", "-a", "-iTCP", "-p", pids.slice(0, 200).join(","), "-F", "pn"], { timeoutMs: 3_000, maxBytes: 1024 * 1024, ...runOpt });
      return result ? parseLsofConnections(result.stdout) : [];
    },
  };
}

const WINDOWS_TREE_QUERY =
  "$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
  + "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";

export function windowsSampler(run?: Runner, pollMs = 3_000): Sampler {
  const runOpt = run ? { run } : {};
  return {
    method: "netstat",
    pollMs,
    async tree(selfPid) {
      const result = await runTool("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_QUERY], { timeoutMs: 8_000, maxBytes: 4 * 1024 * 1024, ...runOpt });
      return result && result.code === 0 ? descendantsOf(selfPid, parseWindowsProcesses(result.stdout)) : [];
    },
    async connections(pids) {
      const wanted = new Set(pids);
      const out: Array<{ pid: number; ip: string; port: number }> = [];
      for (const family of ["TCP", "TCPv6"]) {
        const result = await runTool("netstat", ["-ano", "-p", family], { timeoutMs: 5_000, maxBytes: 2 * 1024 * 1024, ...runOpt });
        for (const row of parseNetstat(result?.stdout ?? "", "ESTABLISHED")) {
          const remote = splitHostPort(row.remote);
          if (remote && wanted.has(row.pid)) out.push({ pid: row.pid, ip: remote.address, port: remote.port });
        }
      }
      return out;
    },
  };
}

export function defaultSampler(platform: NodeJS.Platform = process.platform): Sampler | null {
  if (platform === "linux") return linuxSampler();
  if (platform === "darwin") return macSampler();
  if (platform === "win32") return windowsSampler();
  return null;
}

// --- the observer -----------------------------------------------------------------------

export type ObserverOptions = { sampler: Sampler; selfPid?: number; now?: () => number };

/** Samples the tool shells' connections while a turn runs. */
export class NetworkObserver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private roots = new Map<number, Root>();
  private sampling: Promise<void> = Promise.resolve();
  private active = false;
  /** Processes already running when the turn began (a language server, an earlier turn's dev server): never a tool root. */
  private preexisting: Set<number> | null = null;
  /** Whether the last sample saw a tool shell running (sample faster then). */
  private busy = false;
  /** Time spent sampling (overhead measurement). */
  sampleMs = 0;
  samples = 0;

  constructor(private readonly options: ObserverOptions) {}

  get method(): string {
    return this.options.sampler.method;
  }

  get pollMs(): number {
    return this.options.sampler.pollMs;
  }

  start(): void {
    this.stopTimer();
    this.roots = new Map();
    this.preexisting = null;
    this.active = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.active) return;
    this.timer = setTimeout(() => {
      this.sampling = this.sample().catch(() => undefined).finally(() => this.schedule(this.busy ? this.options.sampler.activePollMs ?? this.options.sampler.pollMs : this.options.sampler.pollMs));
    }, delay);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One sample: the tool roots under this process and their connections. */
  async sample(): Promise<void> {
    const started = performance.now();
    const now = (this.options.now ?? Date.now)();
    const self = this.options.selfPid ?? process.pid;
    const tree = await this.options.sampler.tree(self);
    const byPid = new Map(tree.map((entry) => [entry.pid, entry]));
    if (this.preexisting === null) {
      // The first sample of the turn only notes what already runs.
      this.preexisting = new Set(tree.map((entry) => entry.pid));
      this.samples += 1;
      this.sampleMs += performance.now() - started;
      return;
    }
    // A tool root is the engine's direct child (bash may exec a lone command, so it need not be a shell),
    // or the topmost `<shell> -c` when no engine is in the tree; without an engine, this process's children.
    const engines = new Set(tree.filter((entry) => isEngineProcess(entry.argv)).map((entry) => entry.pid));
    if (engines.size === 0) engines.add(self);
    const rootOf = new Map<number, number>();
    const findRoot = (pid: number): number => {
      const known = rootOf.get(pid);
      if (known !== undefined) return known;
      const chain: number[] = [];
      let current: ProcSample | undefined = byPid.get(pid);
      let root = -1;
      let shell = -1;
      while (current) {
        chain.push(current.pid);
        if (shellCommandOf(current.argv) !== null) shell = current.pid;
        if (engines.has(current.ppid)) {
          root = current.pid;
          break;
        }
        current = byPid.get(current.ppid);
      }
      if (root === -1) root = shell;
      if (root !== -1 && (this.preexisting!.has(root) || engines.has(root))) root = -1;
      for (const member of chain) if (!rootOf.has(member)) rootOf.set(member, root);
      return root;
    };
    const members: number[] = [];
    for (const entry of tree) {
      const root = findRoot(entry.pid);
      if (root === -1) continue;
      members.push(entry.pid);
      if (!this.roots.has(root) && this.roots.size < MAX_ROOTS_PER_TURN) {
        const argv = byPid.get(root)!.argv;
        this.roots.set(root, { pid: root, command: shellCommandOf(argv) ?? argv.join(" "), firstSeen: now, connections: new Map() });
      }
    }
    this.busy = members.length > 0;
    if (members.length > 0) {
      for (const connection of await this.options.sampler.connections(members)) {
        const root = rootOf.get(connection.pid);
        const record = root !== undefined && root !== -1 ? this.roots.get(root) : undefined;
        if (!record || record.connections.size >= MAX_CONNECTIONS_PER_CALL * 2) continue;
        const key = `${connection.ip}|${connection.port}`;
        if (!record.connections.has(key)) record.connections.set(key, { ip: connection.ip, port: connection.port, first: now });
      }
    }
    this.samples += 1;
    this.sampleMs += performance.now() - started;
  }

  /** Stops sampling (after one last sample) and hands back what the turn's tool shells reached. */
  async stop(): Promise<Root[]> {
    this.active = false;
    this.stopTimer();
    await this.sampling;
    await this.sample().catch(() => undefined);
    const roots = [...this.roots.values()];
    this.roots = new Map();
    return roots;
  }
}

// --- naming hosts and attributing roots to calls -------------------------------------

const HOST_IN_COMMAND = /(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/:\s"'?#]+))|(?:[\w.-]+@([a-z0-9.-]+\.[a-z]{2,}):)|(?<![\w/.@:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;
const FILE_EXTENSIONS = new Set(["git", "js", "ts", "py", "json", "md", "txt", "sh", "yml", "yaml", "toml", "lock", "tsx", "jsx", "go", "rs", "rb", "html", "css", "log", "cfg", "ini", "zip", "gz", "tgz", "tar", "whl", "csv", "xml", "env", "mjs", "cjs", "map", "so", "dll", "exe", "pyc", "java", "kt", "c", "h", "cpp", "php", "sql"]);

/** Registries a package manager or tool reaches without naming them in the command. */
const KNOWN_HOSTS: Array<[RegExp, string[]]> = [
  [/\b(?:npm|npx|pnpm|pnpx|yarn|bun|bunx|corepack)\b/, ["registry.npmjs.org", "registry.yarnpkg.com"]],
  [/\b(?:pip3?|uv|uvx|pipx|poetry|pipenv|twine)\b/, ["pypi.org", "files.pythonhosted.org"]],
  [/\bgo\b/, ["proxy.golang.org", "sum.golang.org"]],
  [/\b(?:cargo|rustup)\b/, ["index.crates.io", "static.crates.io", "static.rust-lang.org"]],
  [/\b(?:gem|bundle|bundler)\b/, ["rubygems.org", "index.rubygems.org"]],
  [/\b(?:git|gh)\b/, ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com"]],
  [/\b(?:docker|podman)\b/, ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"]],
  [/\b(?:mvn|gradle|gradlew)\b/, ["repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org"]],
  [/\bcomposer\b/, ["repo.packagist.org"]],
  [/\bdeno\b/, ["jsr.io", "deno.land", "registry.npmjs.org"]],
];

export function knownHostsOf(command: string): string[] {
  const out = new Set<string>();
  for (const [pattern, hosts] of KNOWN_HOSTS) if (pattern.test(command)) for (const host of hosts) out.add(host);
  return [...out];
}

/** Hostnames a command names (URLs, git@host:, bare domain names; file names excluded). */
export function hostnamesInCommand(command: string): string[] {
  const out = new Set<string>();
  for (const match of command.matchAll(HOST_IN_COMMAND)) {
    const host = (match[1] ?? match[2] ?? match[3] ?? "").toLowerCase().replace(/\.$/, "");
    if (!host || /^\d+(?:\.\d+)*$/.test(host)) continue;
    const tld = host.split(".").at(-1)!;
    if (!match[1] && !match[2] && FILE_EXTENSIONS.has(tld)) continue;
    out.add(host);
    if (out.size >= 20) break;
  }
  return [...out];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
}

export type HostResolver = { lookup: (host: string) => Promise<string[]>; reverse: (ip: string) => Promise<string[]> };
export const SYSTEM_RESOLVER: HostResolver = {
  lookup: async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
  reverse: (ip) => dns.reverse(ip),
};

function normalizeIp(ip: string): string {
  return ip.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
}

/** Names the remote endpoints: from the command's hostnames, else reverse DNS (short timeout); never the raw address. */
export async function nameConnections(seen: Seen[], command: string, resolver: HostResolver = SYSTEM_RESOLVER): Promise<Connection[]> {
  const byIp = new Map<string, { host: string; by: "command" | "known_host" }>();
  const named = hostnamesInCommand(command);
  const candidates: Array<[string, "command" | "known_host"]> = [...named.map((host) => [host, "command"] as [string, "command"]), ...knownHostsOf(command).filter((host) => !named.includes(host)).map((host) => [host, "known_host"] as [string, "known_host"])];
  // Looked up together, assigned in order: a host the command names wins, then the first known registry.
  const answers = await Promise.all(candidates.map(([host]) => withTimeout(resolver.lookup(host), 1_000)));
  candidates.forEach(([host, by], index) => {
    for (const ip of answers[index] ?? []) {
      const key = normalizeIp(ip);
      if (!byIp.has(key)) byIp.set(key, { host, by });
    }
  });
  const reverse = new Map<string, Promise<string | null>>();
  const out: Connection[] = [];
  for (const entry of seen.slice(0, MAX_CONNECTIONS_PER_CALL)) {
    const ip = normalizeIp(entry.ip);
    const cls = addressClass(ip);
    const match = byIp.get(ip);
    let host: string | null = match?.host ?? null;
    let by: Connection["resolved_by"] = match?.by ?? null;
    if (!host && cls === "loopback") {
      host = "localhost";
      by = "loopback";
    }
    if (!host && cls !== "any") {
      if (!reverse.has(ip)) reverse.set(ip, withTimeout(resolver.reverse(ip), 500).then((names) => names?.[0] ?? null));
      host = await reverse.get(ip)!;
      if (host) by = "reverse";
    }
    out.push({ host, port: entry.port, address_class: cls, resolved_by: by, first_seen: new Date(entry.first).toISOString() });
  }
  // One row per (host or class, port).
  const unique = new Map<string, Connection>();
  for (const connection of out) {
    const key = `${connection.host ?? connection.address_class}|${connection.port}`;
    if (!unique.has(key)) unique.set(key, connection);
  }
  return [...unique.values()];
}

function normalizeCommand(command: string): string {
  return command.replace(/["'\\]/g, "").replace(/\s+/g, " ").trim();
}

function sameCommand(left: string, right: string): boolean {
  const a = normalizeCommand(left);
  const b = normalizeCommand(right);
  return a === b || (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a)));
}

/** Matches the turn's tool shells to its shell calls; what matches no call is the turn's. */
export async function attributeConnections(
  roots: Root[],
  calls: ToolCall[],
  context: { turn: number; method: string; pollMs: number; resolver?: HostResolver },
): Promise<NetworkEvent[]> {
  const shellCalls = calls.filter((call) => call.command);
  const perCall = new Map<ToolCall, Seen[]>();
  const turn: Seen[] = [];
  const turnCommands: string[] = [];
  for (const root of roots) {
    if (root.connections.size === 0) continue;
    const candidates = shellCalls.filter((call) => sameCommand(call.command!, root.command));
    const timed = candidates.filter((call) => call.start === null || (root.firstSeen >= call.start - 2_000 && (call.end === null || root.firstSeen <= call.end + 2_000)));
    const call = (timed.length > 0 ? timed : candidates)[0];
    if (call) perCall.set(call, [...(perCall.get(call) ?? []), ...root.connections.values()]);
    else {
      turn.push(...root.connections.values());
      turnCommands.push(root.command);
    }
  }
  const events: NetworkEvent[] = [];
  for (const [call, seen] of perCall) {
    const connections = await nameConnections(seen, call.command ?? "", context.resolver);
    events.push({ tool_call_id: call.callId, tool: call.tool, scope: "call", turn: context.turn, method: context.method, poll_ms: context.pollMs, connections, truncated: seen.length > MAX_CONNECTIONS_PER_CALL });
  }
  if (turn.length > 0) {
    const connections = await nameConnections(turn, turnCommands.join("\n"), context.resolver);
    events.push({ tool_call_id: null, tool: "bash", scope: "turn", turn: context.turn, method: context.method, poll_ms: context.pollMs, connections, truncated: turn.length > MAX_CONNECTIONS_PER_CALL });
  }
  return events;
}
