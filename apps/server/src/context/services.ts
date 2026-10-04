// #7 Services: the running docker containers (when docker answers without
// sudo), the local databases listening on this machine with the version of
// their command-line client (never connecting, never with credentials), and
// the compose files of the project and of the running compose projects.

import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { resolveCommand, runTool, type Runner } from "./exec.js";
import { addressClass, cleanText, tildePath, type PrivacyContext, type Scrubber } from "./privacy.js";
import type { ListeningPort, ProcessInfo } from "./processes.js";

export const MAX_CONTAINERS = 100;
const MAX_COMPOSE_FILES = 50;
const COMPOSE_NAME = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "target", ".next", "vendor", "__pycache__", ".cache"]);

export type DockerContainer = { name: string; image: string; image_digest: string | null; ports: string; status: string };
export type LocalDatabase = { kind: string; port: number; address: string; client_version: string | null; process: string | null };
export type Services = {
  /**
   * Only the containers the session started or that bind-mount the project
   * (or one of its outside folders) are named; `other_containers` counts the rest.
   */
  docker: { reachable: boolean; containers: DockerContainer[]; other_containers?: number; truncated?: boolean; skipped?: string };
  databases: LocalDatabase[];
  compose_files: string[];
};

/** Well-known database ports, and the client that names the version. */
export const DATABASE_PORTS: Record<number, { kind: string; probes?: Array<{ command: string; args: string[] }> }> = {
  5432: { kind: "postgres", probes: [{ command: "psql", args: ["--version"] }, { command: "postgres", args: ["--version"] }] },
  3306: { kind: "mysql", probes: [{ command: "mysql", args: ["--version"] }, { command: "mysqld", args: ["--version"] }, { command: "mariadb", args: ["--version"] }] },
  33060: { kind: "mysql-x" },
  27017: { kind: "mongodb", probes: [{ command: "mongod", args: ["--version"] }, { command: "mongosh", args: ["--version"] }] },
  6379: { kind: "redis", probes: [{ command: "redis-server", args: ["--version"] }, { command: "redis-cli", args: ["--version"] }, { command: "valkey-server", args: ["--version"] }] },
  11211: { kind: "memcached", probes: [{ command: "memcached", args: ["-V"] }] },
  9200: { kind: "elasticsearch" },
  5672: { kind: "rabbitmq" },
  1433: { kind: "mssql" },
  1521: { kind: "oracle" },
  9042: { kind: "cassandra" },
  26257: { kind: "cockroachdb", probes: [{ command: "cockroach", args: ["version", "--build-tag"] }] },
  7687: { kind: "neo4j" },
  5984: { kind: "couchdb" },
  8086: { kind: "influxdb", probes: [{ command: "influxd", args: ["version"] }] },
  8123: { kind: "clickhouse", probes: [{ command: "clickhouse", args: ["--version"] }] },
};

/** Database server process names, for a database on a port other than its usual one. */
const DATABASE_PROCESSES: Record<string, number> = {
  postgres: 5432, postmaster: 5432, mysqld: 3306, mariadbd: 3306, mongod: 27017, "redis-server": 6379, "valkey-server": 6379,
  memcached: 11211, "clickhouse-server": 8123, cockroach: 26257, influxd: 8086,
};

/** `docker ps --format '{{json .}}'` lines. */
export function parseDockerPs(text: string): Array<{ id: string; name: string; image: string; ports: string; status: string; labels: string }> {
  const out: Array<{ id: string; name: string; image: string; ports: string; status: string; labels: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      out.push({
        id: String(row.ID ?? ""),
        name: String(row.Names ?? ""),
        image: String(row.Image ?? ""),
        ports: String(row.Ports ?? ""),
        status: String(row.Status ?? ""),
        labels: String(row.Labels ?? ""),
      });
    } catch {
      // Not a JSON row.
    }
  }
  return out;
}

/** The compose files a container's labels name (`com.docker.compose.project.config_files=a.yml,b.yml`). */
export function composeFilesOfLabels(labels: string): string[] {
  const match = /(?:^|,)com\.docker\.compose\.project\.config_files=([^,]*(?:,[^=,]*(?=,|$))*)/.exec(labels);
  if (!match) return [];
  return match[1]!.split(",").map((file) => file.trim()).filter((file) => /\.ya?ml$/i.test(file));
}

/** Whether docker can be asked without sudo: a reachable socket, a DOCKER_HOST, or a platform where the CLI talks to a desktop VM. */
async function dockerReachable(platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "linux" || process.env.DOCKER_HOST) return true;
  for (const socket of ["/var/run/docker.sock", "/run/docker.sock", join(process.env.XDG_RUNTIME_DIR ?? "/nonexistent", "docker.sock")]) {
    try {
      await access(socket, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      // Next.
    }
  }
  return false;
}

export function firstVersionLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : null;
}

async function findComposeFiles(root: string, maxDepth = 3): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (out.length >= MAX_COMPOSE_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_COMPOSE_FILES) return;
      if (entry.isFile() && COMPOSE_NAME.test(entry.name)) out.push(join(dir, entry.name));
      else if (entry.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

/** One `docker inspect --format '{{.Id}} {{.Image}} {{.Created}} {{json .Mounts}}'` line. */
export function parseInspectLine(line: string): { id: string; image: string; createdMs: number | null; bindSources: string[] } | null {
  const match = /^(\S+) (\S+) (\S+) (.*)$/.exec(line.trim());
  if (!match) return null;
  const created = Date.parse(match[3]!.replace(/(\.\d{3})\d+/, "$1"));
  let bindSources: string[] = [];
  try {
    const mounts = JSON.parse(match[4]!) as Array<{ Type?: string; Source?: string }>;
    if (Array.isArray(mounts)) bindSources = mounts.filter((mount) => mount && mount.Type === "bind" && typeof mount.Source === "string").map((mount) => mount.Source!);
  } catch {
    bindSources = [];
  }
  return { id: match[1]!, image: match[2]!, createdMs: Number.isFinite(created) ? created : null, bindSources };
}

function insideFolder(path: string, folders: readonly string[]): boolean {
  const portable = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return folders.some((folder) => {
    const base = folder.replaceAll("\\", "/").replace(/\/+$/, "");
    return base.length > 1 && (portable === base || portable.startsWith(`${base}/`));
  });
}

export type ServicesOptions = {
  /** When the session started: a container created since is the session's. */
  sessionStartMs?: number;
  /** Outside folders of the session, beside the project root. */
  folders?: readonly string[];
  root: string;
  listening: ListeningPort[];
  processes: ProcessInfo[];
  privacy: PrivacyContext;
  scrub: Scrubber;
  platform?: NodeJS.Platform;
  run?: Runner;
  resolve?: (command: string) => string | null;
};

/** A path for the record: inside the project as `$PROJECT/...`, else with the home as `~`. */
export function recordPath(path: string, root: string, privacy: PrivacyContext): string {
  const rel = relative(root, path);
  if (rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) && !rel.startsWith("/")) return `$PROJECT/${rel.split(/[\\/]/).join("/")}`;
  if (rel === "") return "$PROJECT";
  return tildePath(path, privacy);
}

export async function collectServices(options: ServicesOptions): Promise<Services> {
  const platform = options.platform ?? process.platform;
  const tool = (command: string, args: string[], timeoutMs = 5_000) => runTool(command, args, {
    timeoutMs,
    maxBytes: 1024 * 1024,
    ...(options.run ? { run: options.run } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
  });
  const clean = (text: string) => cleanText(text, options.privacy, options.scrub);

  // Docker.
  const docker: Services["docker"] = { reachable: false, containers: [] };
  const composeFiles = new Set<string>();
  if (!(options.resolve ?? resolveCommand)("docker")) {
    docker.skipped = "not_installed";
  } else if (!(await dockerReachable(platform))) {
    docker.skipped = "no_access";
  } else {
    const ps = await tool("docker", ["ps", "--no-trunc", "--format", "{{json .}}"], 8_000);
    if (ps && ps.code === 0) {
      docker.reachable = true;
      const rows = parseDockerPs(ps.stdout).slice(0, 500);
      // Each container's image, creation time and bind mounts, in one call.
      const imageOf = new Map<string, string>();
      const related = new Set<string>();
      if (rows.length > 0) {
        const inspected = await tool("docker", ["inspect", "--format", "{{.Id}} {{.Image}} {{.Created}} {{json .Mounts}}", ...rows.map((row) => row.id)], 8_000);
        const folders = [options.root, ...(options.folders ?? [])];
        for (const line of inspected?.stdout.split(/\r?\n/) ?? []) {
          const parsed = parseInspectLine(line);
          if (!parsed) continue;
          imageOf.set(parsed.id, parsed.image);
          const startedInSession = options.sessionStartMs !== undefined && parsed.createdMs !== null && parsed.createdMs >= options.sessionStartMs - 5_000;
          if (startedInSession || parsed.bindSources.some((source) => insideFolder(source, folders))) related.add(parsed.id);
        }
      }
      const ours = rows.filter((row) => [...related].some((id) => id.startsWith(row.id) || row.id.startsWith(id)));
      docker.other_containers = rows.length - ours.length;
      const kept = ours.slice(0, MAX_CONTAINERS);
      if (ours.length > MAX_CONTAINERS) docker.truncated = true;
      // Image digests: image id -> repo digest.
      const digests = new Map<string, string>();
      if (kept.length > 0) {
        const imageIds = [...new Set(imageOf.values())];
        if (imageIds.length > 0) {
          const repo = await tool("docker", ["image", "inspect", "--format", "{{.Id}} {{json .RepoDigests}}", ...imageIds], 8_000);
          const repoDigest = new Map<string, string>();
          for (const line of repo?.stdout.split(/\r?\n/) ?? []) {
            const at = line.indexOf(" ");
            if (at < 0) continue;
            try {
              const list = JSON.parse(line.slice(at + 1)) as string[];
              if (Array.isArray(list) && typeof list[0] === "string") repoDigest.set(line.slice(0, at), list[0]);
            } catch {
              // No digests.
            }
          }
          for (const [container, image] of imageOf) digests.set(container, repoDigest.get(image) ?? image);
        }
      }
      docker.containers = kept.map((row) => ({
        name: clean(row.name),
        image: clean(row.image),
        image_digest: [...digests].find(([id]) => id.startsWith(row.id) || row.id.startsWith(id))?.[1] ?? null,
        ports: clean(row.ports),
        status: clean(row.status),
      }));
      for (const row of kept) for (const file of composeFilesOfLabels(row.labels)) composeFiles.add(file);
    } else {
      docker.skipped = ps?.timedOut ? "timeout" : "unreachable";
    }
  }

  // Local databases: by well-known port, or by a database server process listening anywhere.
  const databases: LocalDatabase[] = [];
  const versions = new Map<string, Promise<string | null>>();
  const seen = new Set<string>();
  for (const port of options.listening) {
    const byPort = DATABASE_PORTS[port.port];
    const processName = (port.process ?? "").toLowerCase().replace(/\.exe$/, "");
    const byProcessPort = DATABASE_PROCESSES[processName];
    const known = byPort ?? (byProcessPort !== undefined ? DATABASE_PORTS[byProcessPort] : undefined);
    if (!known) continue;
    const key = `${known.kind}|${port.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The first installed client (or server binary) that names its version; never connects.
    const version: Promise<string | null> = versions.get(known.kind) ?? (async () => {
      for (const probe of known.probes ?? []) {
        const result = await tool(probe.command, probe.args, 4_000);
        const line = result && result.code === 0 ? firstVersionLine(result.stdout || result.stderr) : null;
        if (line) return line;
      }
      return null;
    })();
    versions.set(known.kind, version);
    databases.push({ kind: known.kind, port: port.port, address: addressClass(port.address), client_version: null, process: port.process });
    const entry = databases[databases.length - 1]!;
    entry.client_version = await version.then((v) => (v ? clean(v) : null));
  }

  for (const file of await findComposeFiles(options.root)) composeFiles.add(file);
  return {
    docker,
    databases,
    compose_files: [...composeFiles].slice(0, MAX_COMPOSE_FILES).map((file) => clean(recordPath(file, options.root, options.privacy))),
  };
}
