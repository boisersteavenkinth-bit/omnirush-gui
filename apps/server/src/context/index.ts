// Capture context (capture v2): what the session's machine looked like
// around the agent, recorded as trace events beside the conversation.
//
//   session start  context.environment (system packages #5, services #7,
//                  setup #16, package-manager config #17, shell aliases
//                  #18), context.setup_files (#16 skill/plugin texts) and
//                  context.processes (#19, phase session_start)
//   turn start     context.processes (#19, phase turn_start); the network
//                  observer starts (#20)
//   turn messages  context.outside_folder / context.outside_file (#10,
//                  #21) and context.ephemeral_tool (#22) from its tool calls
//   turn end       context.network (#20) per shell call (or per turn)
//
// Everything runs in the background with timeouts and never delays a turn
// or an upload; every item is capped, has the home directory as `~`, and
// goes through the uploader's CONFIG secret scrub (here, and again when the
// trace is uploaded). OMNIRUSH_CAPTURE_CONTEXT=0 turns the whole module off;
// OMNIRUSH_CAPTURE_NETWORK=0 only the network observer.

import { toolCallsOf, commandEffects, toolKind, type ToolCall } from "./commands.js";
import { resolveEphemeral, type ResolveEphemeralOptions } from "./ephemeral.js";
import { attributeConnections, defaultSampler, NetworkObserver, type HostResolver, type Sampler } from "./network.js";
import { OutsideTracker } from "./outside.js";
import { collectPmConfig } from "./pm-config.js";
import { currentPrivacy, type PrivacyContext, type Scrubber } from "./privacy.js";
import { processSnapshot, processTable, listeningPorts, type ProcessInfo, type ListeningPort } from "./processes.js";
import { collectServices } from "./services.js";
import { collectSetup, type SetupFile, type SetupModel } from "./setup.js";
import { collectShellAliases } from "./shell-aliases.js";
import { systemPackages } from "./system-packages.js";

export const CONTEXT_SCHEMA = 1;
const SECTION_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 1_000;
const MAX_SETUP_FILES_EVENT_BYTES = 512 * 1024;
const MAX_EPHEMERAL_PER_SESSION = 500;

export type ContextEventType =
  | "context.environment"
  | "context.setup_files"
  | "context.processes"
  | "context.network"
  | "context.ephemeral_tool"
  | "context.outside_folder"
  | "context.outside_file";

/** Whether capture context is on: OMNIRUSH_CAPTURE_CONTEXT=0 (or false/off/no) turns it off. */
export function captureContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|false|off|no)$/i.test((env.OMNIRUSH_CAPTURE_CONTEXT ?? "").trim());
}

/** Whether the network observer (#20) is on: OMNIRUSH_CAPTURE_NETWORK=0 turns it off. */
export function captureNetworkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return captureContextEnabled(env) && !/^(?:0|false|off|no)$/i.test((env.OMNIRUSH_CAPTURE_NETWORK ?? "").trim());
}

export type ContextOptions = {
  client: "cli" | "gui";
  appVersion?: string | null;
  engineVersion?: string | null;
  /** Where the once-a-day system package list is cached (the app's state directory). */
  cacheDir?: string | null;
  scrub: Scrubber;
  /** Appends a trace event to the session (the uploader's trace, scrubbed again on upload). */
  record: (sessionId: string, type: ContextEventType, data: unknown) => void;
  /** Reports an absolute outside file to the project archive (byte-exact copy). */
  reportPath?: (sessionId: string, absolute: string) => void;
  /** The archive's exclusion of an absolute outside path (credential, app state, dependency, system), else null. */
  exclusion?: (absolute: string) => string | null;
  /** The upload denylist for a relative path (credential files), applied to skill/plugin files. */
  denied?: (relPath: string) => boolean;
  /** The session's latest model (the uploader's session.model). */
  model?: (sessionId: string) => SetupModel | null;
  settings?: () => Record<string, unknown>;
  bundledSkillDirs?: string[];
  bundledSkills?: Array<{ name: string; version: string | null; sha256: string }>;
  configFiles?: string[];
  mcpFiles?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Tests: overrides. */
  enabled?: boolean;
  network?: boolean;
  sampler?: Sampler | null;
  resolver?: HostResolver;
  privacy?: PrivacyContext;
  ephemeral?: ResolveEphemeralOptions;
  /** Tests: skip the slow machine-wide sections. */
  sections?: Partial<Record<"system_packages" | "services" | "setup" | "pm_config" | "shell_aliases" | "processes", boolean>>;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

type SessionContext = {
  id: string;
  root: string;
  startedAt: number;
  turn: number;
  outside: OutsideTracker;
  observer: NetworkObserver | null;
  /** Tool calls of the current turn, by call id (or position). */
  calls: Map<string, ToolCall>;
  processedCalls: Set<string>;
  ephemeral: number;
  pending: Set<Promise<unknown>>;
  ended: boolean;
};

/** Overhead bookkeeping (milliseconds of wall time spent in each phase). */
export type ContextTimings = { session_start: number[]; turn_start: number[]; turn_messages: number[]; turn_end: number[]; network_sample_ms: number; network_samples: number };

/** Active turns across every capture in this process: an unmatched tool shell is only a turn's when one turn runs. */
const activeTurns = new Set<string>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { timeout: true } | { error: true }> {
  return Promise.race([
    promise.then((value) => ({ value }), () => ({ error: true as const })),
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), ms).unref?.()),
  ]);
}

export class ContextCapture {
  readonly enabled: boolean;
  readonly networkEnabled: boolean;
  readonly timings: ContextTimings = { session_start: [], turn_start: [], turn_messages: [], turn_end: [], network_sample_ms: 0, network_samples: 0 };
  private readonly sessions = new Map<string, SessionContext>();
  private readonly privacy: PrivacyContext;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: ContextOptions) {
    this.env = options.env ?? process.env;
    this.enabled = options.enabled ?? captureContextEnabled(this.env);
    this.networkEnabled = this.enabled && (options.network ?? captureNetworkEnabled(this.env));
    this.privacy = options.privacy ?? currentPrivacy();
    this.platform = options.platform ?? process.platform;
  }

  private section(name: keyof NonNullable<ContextOptions["sections"]>): boolean {
    return this.options.sections?.[name] !== false;
  }

  private emit(sessionId: string, type: ContextEventType, data: unknown): void {
    try {
      this.options.record(sessionId, type, this.options.scrub.json(data));
    } catch (error) {
      this.options.log?.("warn", "capture context: event dropped", { type, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private track(state: SessionContext, work: Promise<unknown>): void {
    const guarded = work.catch((error) => this.options.log?.("warn", "capture context failed", { error: error instanceof Error ? error.message : String(error) }));
    state.pending.add(guarded);
    void guarded.finally(() => state.pending.delete(guarded));
  }

  sessionStarted(sessionId: string, root: string): void {
    if (!this.enabled || this.sessions.has(sessionId)) return;
    const state: SessionContext = {
      id: sessionId,
      root,
      startedAt: Date.now(),
      turn: 0,
      outside: new OutsideTracker({
        root,
        sessionStartMs: Date.now(),
        privacy: this.privacy,
        scrub: this.options.scrub,
        exclusion: this.options.exclusion ?? (() => null),
        reportPath: (absolute) => this.options.reportPath?.(sessionId, absolute),
      }),
      observer: null,
      calls: new Map(),
      processedCalls: new Set(),
      ephemeral: 0,
      pending: new Set(),
      ended: false,
    };
    if (this.networkEnabled) {
      const sampler = this.options.sampler === undefined ? defaultSampler(this.platform) : this.options.sampler;
      if (sampler) state.observer = new NetworkObserver({ sampler });
    }
    this.sessions.set(sessionId, state);
    this.track(state, this.collectSessionStart(state));
  }

  private async collectSessionStart(state: SessionContext): Promise<void> {
    const started = performance.now();
    const timings: Record<string, number> = {};
    const errors: Record<string, string> = {};
    const timed = async <T>(name: string, work: () => Promise<T>): Promise<T | undefined> => {
      const at = performance.now();
      const result = await withTimeout(work(), SECTION_TIMEOUT_MS);
      timings[name] = Math.round(performance.now() - at);
      if ("value" in result) return result.value;
      errors[name] = "timeout" in result ? "timeout" : "failed";
      return undefined;
    };
    const { privacy } = this;
    const scrub = this.options.scrub;
    const runOpts = { platform: this.platform };

    // Processes and ports first: services reads the listening ports.
    let table: ProcessInfo[] = [];
    let listening: ListeningPort[] = [];
    if (this.section("processes")) {
      const snapshot = await timed("processes", async () => {
        const { processes, method } = await processTable(runOpts);
        table = processes;
        const ports = await listeningPorts(processes, runOpts);
        listening = ports.ports;
        return processSnapshot("session_start", 0, { ...runOpts, privacy, scrub, precomputed: { processes, listening, method: `${method}+${ports.method}` } });
      });
      if (snapshot) this.emit(state.id, "context.processes", snapshot);
    }

    const [packages, services, setup, pmConfig, aliases] = await Promise.all([
      this.section("system_packages") ? timed("system_packages", () => systemPackages({ platform: this.platform, cacheDir: this.options.cacheDir ?? null })) : undefined,
      this.section("services") ? timed("services", () => collectServices({ root: state.root, listening, processes: table, privacy, scrub, platform: this.platform })) : undefined,
      this.section("setup")
        ? timed("setup", () => collectSetup({
          root: state.root,
          client: this.options.client,
          appVersion: this.options.appVersion ?? null,
          engineVersion: this.options.engineVersion ?? null,
          model: this.options.model?.(state.id) ?? null,
          settings: this.options.settings?.() ?? {},
          bundledSkillDirs: this.options.bundledSkillDirs ?? [],
          bundledSkills: this.options.bundledSkills ?? [],
          configFiles: this.options.configFiles ?? [],
          mcpFiles: this.options.mcpFiles ?? [],
          privacy,
          scrub,
          ...(this.options.denied ? { denied: this.options.denied } : {}),
          env: this.env,
        }))
        : undefined,
      this.section("pm_config") ? timed("pm_config", () => collectPmConfig({ privacy, scrub, platform: this.platform, env: this.env })) : undefined,
      this.section("shell_aliases") ? timed("shell_aliases", () => collectShellAliases({ privacy, scrub, platform: this.platform, env: this.env })) : undefined,
    ]);
    timings.total = Math.round(performance.now() - started);
    this.timings.session_start.push(timings.total);
    this.emit(state.id, "context.environment", {
      schema: CONTEXT_SCHEMA,
      collected_at: new Date().toISOString(),
      platform: this.platform,
      ...(packages ? { system_packages: packages } : {}),
      ...(services ? { services } : {}),
      ...(setup ? { setup: setup.setup } : {}),
      ...(pmConfig ? { pm_config: pmConfig } : {}),
      ...(aliases ? { shell_aliases: aliases } : {}),
      timings_ms: timings,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    });
    if (setup && setup.files.length > 0) this.emitSetupFiles(state.id, setup.files);
  }

  /** The skill/plugin texts in events of at most ~512 KiB each. */
  private emitSetupFiles(sessionId: string, files: SetupFile[]): void {
    const parts: SetupFile[][] = [[]];
    let bytes = 0;
    for (const file of files) {
      const size = Buffer.byteLength(JSON.stringify(file));
      if (bytes + size > MAX_SETUP_FILES_EVENT_BYTES && parts[parts.length - 1]!.length > 0) {
        parts.push([]);
        bytes = 0;
      }
      parts[parts.length - 1]!.push(file);
      bytes += size;
    }
    parts.forEach((part, index) => this.emit(sessionId, "context.setup_files", { files: part, part: index + 1, parts: parts.length }));
  }

  /**
   * A prompt was dispatched. `after`: work the turn's own capture does first
   * (the uploader's artifact baseline listing); the process snapshot waits
   * for it so the two never compete for the disk and the event loop.
   */
  turnStarted(sessionId: string, after?: Promise<unknown>): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    state.turn += 1;
    state.calls = new Map();
    if (state.observer) {
      activeTurns.add(sessionId);
      state.observer.start();
    }
    if (!this.section("processes")) return;
    const turn = state.turn;
    this.track(state, (async () => {
      if (after) await withTimeout(after, SECTION_TIMEOUT_MS);
      const started = performance.now();
      const snapshot = await withTimeout(processSnapshot("turn_start", turn, { platform: this.platform, privacy: this.privacy, scrub: this.options.scrub }), SECTION_TIMEOUT_MS);
      this.timings.turn_start.push(Math.round(performance.now() - started));
      if ("value" in snapshot) this.emit(sessionId, "context.processes", snapshot.value);
    })());
  }

  /** The turn's engine messages (possibly in several parts): its tool calls feed #10, #21 and #22. */
  turnMessages(sessionId: string, messages: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const calls = toolCallsOf(messages, state.root, this.privacy.home);
    const fresh: ToolCall[] = [];
    calls.forEach((call, index) => {
      const key = call.callId ?? `${state.turn}:${index}:${call.tool}:${call.start ?? ""}`;
      state.calls.set(key, call);
      if (state.processedCalls.has(key) || (call.status !== null && call.status !== "completed" && call.status !== "error")) return;
      state.processedCalls.add(key);
      fresh.push(call);
    });
    if (fresh.length === 0) return;
    this.track(state, (async () => {
      const started = performance.now();
      const outside = await state.outside.processCalls(fresh);
      for (const folder of outside.folders) this.emit(sessionId, "context.outside_folder", folder);
      for (const file of outside.files) this.emit(sessionId, "context.outside_file", file);
      for (const call of fresh) {
        if (toolKind(call.tool) !== "shell" || !call.command) continue;
        for (const tool of commandEffects(call.command, call.cwd, this.privacy.home).ephemeral) {
          if (state.ephemeral >= MAX_EPHEMERAL_PER_SESSION) break;
          state.ephemeral += 1;
          const runner = tool.runner === "bun x" ? "bunx" : tool.runner;
          const resolved = await resolveEphemeral(
            { tool_call_id: call.callId, runner, package: tool.package, requested: tool.requested },
            { home: this.privacy.home, platform: this.platform, env: this.env, ...(this.options.ephemeral ?? {}) },
          );
          this.emit(sessionId, "context.ephemeral_tool", resolved);
        }
      }
      this.timings.turn_messages.push(Math.round(performance.now() - started));
    })());
  }

  /** The turn ended: the network observer stops and its connections are attributed to the turn's calls. */
  turnEnded(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !state.observer) return;
    const observer = state.observer;
    const calls = [...state.calls.values()];
    const turn = state.turn;
    const alone = activeTurns.size <= 1;
    activeTurns.delete(sessionId);
    this.track(state, (async () => {
      const started = performance.now();
      const roots = await observer.stop();
      this.timings.network_sample_ms = observer.sampleMs;
      this.timings.network_samples = observer.samples;
      const events = await attributeConnections(roots, calls, { turn, method: observer.method, pollMs: observer.pollMs, ...(this.options.resolver ? { resolver: this.options.resolver } : {}) });
      for (const event of events) {
        // Another session's turn ran at the same time: an unmatched shell may be its.
        if (event.scope === "turn" && !alone) continue;
        this.emit(sessionId, "context.network", event);
      }
      this.timings.turn_end.push(Math.round(performance.now() - started));
    })());
  }

  /** Resolves once the session's background work is done (or after `timeoutMs`). */
  async settled(sessionId: string, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const deadline = Date.now() + timeoutMs;
    while (state.pending.size > 0 && Date.now() < deadline) {
      await withTimeout(Promise.all([...state.pending]), Math.max(1, deadline - Date.now()));
    }
  }

  sessionEnded(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.ended) return;
    if (state.observer && activeTurns.has(sessionId)) this.turnEnded(sessionId);
    state.ended = true;
    void this.settled(sessionId, SETTLE_TIMEOUT_MS).finally(() => this.sessions.delete(sessionId));
  }
}
