import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { startCaptureService, type CaptureService } from "../../../../apps/server/src/capture-client.js";
import type { TraceCapabilities } from "../../../../apps/server/src/session-uploader.js";

const CONTROL_TOKEN = "capture-lab-control";
const UPLOAD_TOKEN = "capture-lab-upload";
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
type Actor = "actor-a" | "actor-b";
const ACTORS: readonly Actor[] = ["actor-a", "actor-b"];

export type CaptureEfficiencyAttempt = {
  sessionId: string;
  status: number;
  snapshotType: string;
  schemaVersion: number | null;
  workspaceRoot: string | null;
  filePaths: string[];
  traceTypes: string[];
  traceFileEventTypes: string[];
  traceFileCount: number;
  actorMarkers: string[];
};

export type CaptureEfficiencyWitness = {
  attempts: CaptureEfficiencyAttempt[];
  capabilityCalls: Record<Actor, number>;
  modes: Array<"starting" | "worker" | "local" | "down">;
};

export type CaptureEfficiencyLab = {
  readonly baseUrl: string;
  readonly controlToken: string;
  witness(): Promise<CaptureEfficiencyWitness>;
  stop(): Promise<void>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`missing string field ${key}`);
  }
  return value[key];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, key: string): number | null {
  if (!isRecord(value) || typeof value[key] !== "number" || !Number.isFinite(value[key])) return null;
  return value[key];
}

function actorValue(value: unknown): Actor {
  const actor = stringValue(value, "actor");
  if (actor === "actor-a" || actor === "actor-b") return actor;
  throw new Error(`unsupported synthetic actor ${actor}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BYTES) throw new Error("request body exceeds lab limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return JSON.parse(body.toString("utf8"));
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function traceSummary(value: unknown): { types: string[]; actors: string[] } {
  if (isRecord(value) && Array.isArray(value.events)) return traceSummary(value.events);
  if (!Array.isArray(value)) return { types: [], actors: [] };
  const types: string[] = [];
  const actors: string[] = [];
  for (const event of value) {
    if (!isRecord(event) || typeof event.type !== "string") continue;
    types.push(event.type);
    if (isRecord(event.data) && typeof event.data.actor === "string") actors.push(event.data.actor);
  }
  return { types, actors };
}

function filePaths(value: unknown): Array<{ path: string; content: string | null }> {
  if (!Array.isArray(value)) return [];
  const files: Array<{ path: string; content: string | null }> = [];
  for (const file of value) {
    if (!isRecord(file) || typeof file.path !== "string") continue;
    files.push({ path: file.path, content: typeof file.content === "string" ? file.content : null });
  }
  return files;
}

function summarizeEnvelope(sessionId: string, status: number, envelope: JsonRecord): CaptureEfficiencyAttempt {
  const workspace = isRecord(envelope.workspace) ? envelope.workspace : null;
  const workspaceRoot = workspace ? optionalString(workspace.root_name) : null;
  const files = filePaths(envelope.files);
  const trace = traceSummary(envelope.trace);
  const traceFiles = files.filter((file) => file.path === "__omnirush__/trace.json");
  let traceFileEventTypes: string[] = [];
  for (const traceFile of traceFiles) {
    if (traceFile.content === null) continue;
    try {
      const parsed: unknown = JSON.parse(traceFile.content);
      traceFileEventTypes = traceSummary(parsed).types;
    } catch {
      traceFileEventTypes = [];
    }
  }
  return {
    sessionId,
    status,
    snapshotType: typeof envelope.snapshot_type === "string" ? envelope.snapshot_type : "",
    schemaVersion: numberValue(envelope, "schema_version"),
    workspaceRoot,
    filePaths: files.map((file) => file.path),
    traceTypes: trace.types,
    traceFileEventTypes,
    traceFileCount: traceFiles.length,
    actorMarkers: trace.actors,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("capture-efficiency lab did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function capability(actor: Actor, calls: Record<Actor, number>): () => Promise<TraceCapabilities> {
  return async () => {
    calls[actor] += 1;
    return { schema_versions: [1, 2, 3], canonical_trace: true };
  };
}

export async function startCaptureEfficiencyLab(): Promise<CaptureEfficiencyLab> {
  const tempRoot = await mkdtemp(join(tmpdir(), "omnirush-capture-efficiency-"));
  const stateRoot = join(tempRoot, "state");
  const workspaceRoot = join(tempRoot, "workspaces");
  await mkdir(workspaceRoot, { recursive: true });

  const attempts: CaptureEfficiencyAttempt[] = [];
  const capabilityCalls: Record<Actor, number> = { "actor-a": 0, "actor-b": 0 };
  const sessions = new Map<string, { actor: Actor; service: CaptureService }>();
  const rejectedSchema3 = new Set(["session-a-0001"]);
  let collectorUrl = "";
  let stopped = false;
  let services: CaptureService[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url?.split("?", 1)[0] ?? "/";
      if (path === "/collector/collect") {
        if (request.method !== "POST" || !authorized(request, UPLOAD_TOKEN)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const header = request.headers["x-omnirush-session-id"];
        const sessionId = typeof header === "string" ? header : Array.isArray(header) ? header[0] ?? "" : "";
        try {
          const compressed = await readBody(request);
          const json: unknown = JSON.parse(zstdDecompressSync(compressed).toString("utf8"));
          if (!isRecord(json)) throw new Error("collector envelope is not an object");
          const schemaVersion = numberValue(json, "schema_version");
          const summary = summarizeEnvelope(sessionId, 201, json);
          if (summary.snapshotType === "trace" && schemaVersion === 3 && rejectedSchema3.has(sessionId)) {
            rejectedSchema3.delete(sessionId);
            attempts.push({ ...summary, status: 422 });
            sendJson(response, 422, { error: "unsupported_schema" });
            return;
          }
          attempts.push(summary);
          sendJson(response, 201, { ok: true });
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid collector body" });
        }
        return;
      }

      if (path === "/witness") {
        if (request.method !== "GET" || !authorized(request, CONTROL_TOKEN)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        sendJson(response, 200, { attempts, capabilityCalls, modes: services.map(service => service.mode()) });
        return;
      }

      if (!path.startsWith("/control/") || !authorized(request, CONTROL_TOKEN)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (services.length === 0) {
        sendJson(response, 503, { error: "capture service is not ready" });
        return;
      }

      const body = await readJson(request);
      const requestedSessionId = stringValue(body, "sessionId");
      if (path === "/control/start") {
        const actor = actorValue(body);
        const workspace = stringValue(body, "workspace");
        const expectedWorkspace = actor === "actor-a" ? "workspace-a" : "workspace-b";
        if (workspace !== expectedWorkspace || sessions.has(requestedSessionId)) {
          sendJson(response, 400, { error: "invalid synthetic session" });
          return;
        }
        const service = services[ACTORS.indexOf(actor)];
        const root = join(workspaceRoot, actor, workspace);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, `notes-${actor.slice(-1)}.txt`), `synthetic ${actor}\n`, "utf8");
        sessions.set(requestedSessionId, { actor, service });
        service.startSession(requestedSessionId, workspace, root);
        await service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }

      const session = sessions.get(requestedSessionId);
      if (!session) {
        sendJson(response, 404, { error: "unknown synthetic session" });
        return;
      }
      if (path === "/control/trace") {
        const type = stringValue(body, "type");
        const data = isRecord(body) && Object.hasOwn(body, "data") ? body.data : undefined;
        session.service.recordTrace(requestedSessionId, type, data);
        await session.service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }
      if (path === "/control/flush") {
        const finalTrace = isRecord(body) && Object.hasOwn(body, "finalTrace") ? body.finalTrace : undefined;
        session.service.flushTrace(requestedSessionId, finalTrace);
        await session.service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }
      if (path === "/control/complete") {
        const finalTrace = isRecord(body) && Object.hasOwn(body, "finalTrace") ? body.finalTrace : undefined;
        session.service.finishSession(requestedSessionId, finalTrace);
        await session.service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }
      sendJson(response, 404, { error: "unknown_control" });
    })().catch((error: unknown) => {
      if (!response.writableEnded) sendJson(response, 500, { error: error instanceof Error ? error.message : "lab request failed" });
    });
  });

  const port = await listen(server);
  collectorUrl = `http://127.0.0.1:${port}`;
  const uploadFile = async (sessionId: string, path: string, size: number, signal?: AbortSignal): Promise<Response> => {
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    const body = Readable.toWeb(stream);
    try {
      const options = {
        method: "POST",
        headers: {
          authorization: "Bearer " + UPLOAD_TOKEN,
          "content-type": "application/zstd",
          "x-omnirush-session-id": sessionId,
        },
        body,
        signal,
        duplex: "half",
      };
      return await fetch(collectorUrl + "/collector/collect", options);
    } finally { stream.destroy(); }
  };

  services = ACTORS.map((actor) => startCaptureService({
    stateDir: join(stateRoot, actor),
    appVersion: "capture-efficiency-lab",
    engineVersion: "capture-efficiency-lab",
    log: () => undefined,
    worker: true,
    sessionUploader: {
      uploadFile,
      capabilities: capability(actor, capabilityCalls),
    },
    archive: {
      enabled: false,
      excludedDirs: [],
    },
  }));

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(services.map((service) => service.stop({ archiveFinals: false })));
    await close(server);
    await rm(tempRoot, { recursive: true, force: true });
  };

  return {
    baseUrl: collectorUrl,
    controlToken: CONTROL_TOKEN,
    witness: async () => {
      const response = await fetch(`${collectorUrl}/witness`, {
        headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
      });
      if (!response.ok) throw new Error(`witness request failed with ${response.status}`);
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.attempts) || !isRecord(body.capabilityCalls)) {
        throw new Error("invalid capture-efficiency witness");
      }
      const witnessAttempts: CaptureEfficiencyAttempt[] = [];
      for (const attempt of body.attempts) {
        if (!isRecord(attempt)) throw new Error("invalid capture-efficiency attempt");
        witnessAttempts.push({
          sessionId: stringValue(attempt, "sessionId"),
          status: numberValue(attempt, "status") ?? 0,
          snapshotType: stringValue(attempt, "snapshotType"),
          schemaVersion: numberValue(attempt, "schemaVersion"),
          workspaceRoot: optionalString(attempt.workspaceRoot),
          filePaths: Array.isArray(attempt.filePaths) ? attempt.filePaths.filter((path): path is string => typeof path === "string") : [],
          traceTypes: Array.isArray(attempt.traceTypes) ? attempt.traceTypes.filter((type): type is string => typeof type === "string") : [],
          traceFileEventTypes: Array.isArray(attempt.traceFileEventTypes)
            ? attempt.traceFileEventTypes.filter((type): type is string => typeof type === "string")
            : [],
          traceFileCount: numberValue(attempt, "traceFileCount") ?? 0,
          actorMarkers: Array.isArray(attempt.actorMarkers) ? attempt.actorMarkers.filter((actor): actor is string => typeof actor === "string") : [],
        });
      }
      const calls: Record<Actor, number> = {
        "actor-a": numberValue(body.capabilityCalls, "actor-a") ?? 0,
        "actor-b": numberValue(body.capabilityCalls, "actor-b") ?? 0,
      };
      const modes: CaptureEfficiencyWitness["modes"] = [];
      if (!Array.isArray(body.modes)) throw new Error("missing worker modes");
      for (const mode of body.modes) {
        if (mode !== "starting" && mode !== "worker" && mode !== "local" && mode !== "down") throw new Error("invalid worker mode");
        modes.push(mode);
      }
      return { attempts: witnessAttempts, capabilityCalls: calls, modes };
    },
    stop,
  };
}
