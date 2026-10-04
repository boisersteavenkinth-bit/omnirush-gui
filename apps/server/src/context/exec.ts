// Running the external commands capture context needs: resolved on PATH
// first (a tool that is not installed is never spawned), at the lowest CPU
// priority, with stdin closed, a hard timeout that kills the whole process
// group, and a cap on what is read back. Never throws: a failure is null.
//
// macOS: a /usr/bin Command Line Tools shim is never run when the tools are
// missing (the guard of capture/command-guard.ts).

import { spawn } from "node:child_process";
import { setPriority } from "node:os";

import { cltSkipReason, configureCltProbe, resolveCommand, type ResolveOptions } from "../command-guard.js";

export type RunResult = { code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };

export type RunOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type Runner = (file: string, args: string[], options?: RunOptions) => Promise<RunResult | null>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** The child environment: the user's, without anything that could make a tool prompt or page. */
export function quietEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    TERM: "dumb",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    DEBIAN_FRONTEND: "noninteractive",
    npm_config_update_notifier: "false",
    ...extra,
  };
}

/** Runs `file` (an absolute path) and resolves with its output, or null when it could not start. */
export const runCommand: Runner = (file, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    // A .cmd/.bat (npm.cmd) only runs through cmd.exe; every argument capture passes is a plain word.
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file)) {
      if (args.some((arg) => /["%^&|<>\r\n]/.test(arg))) {
        resolvePromise(null);
        return;
      }
      args = ["/d", "/s", "/c", `"${[file, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}"`];
      file = process.env.ComSpec || "cmd.exe";
    }
    try {
      child = spawn(file, args, {
        windowsVerbatimArguments: process.platform === "win32" && /cmd\.exe$/i.test(file),
        cwd: options.cwd,
        env: options.env ?? quietEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      resolvePromise(null);
      return;
    }
    if (typeof child.pid === "number") {
      try {
        setPriority(child.pid, 19);
      } catch {
        // Not permitted or already gone: it runs at the normal priority.
      }
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Gone.
        }
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        truncated,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes >= maxBytes) return;
      const room = maxBytes - outBytes;
      if (chunk.length > room) {
        truncated = true;
        out.push(chunk.subarray(0, room));
        outBytes = maxBytes;
        kill();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes >= 64 * 1024) return;
      err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(null);
      }
    });
    child.on("close", (code) => finish(code));
  });
};

// --- PATH lookup and the Command Line Tools guard: capture/command-guard.ts ---------

export { resolveCommand, type ResolveOptions };
/** Test hook: the guard's platform and xcode-select check (command-guard.ts configureCltProbe). */
export const configureContextCltProbe = configureCltProbe;

/** Whether running `resolvedPath` as `command` would open the Command Line Tools install dialog. */
export async function wouldPromptClt(command: string, resolvedPath: string | null): Promise<boolean> {
  return (await cltSkipReason(command, resolvedPath)) !== null;
}

/**
 * Resolves `command` on PATH and runs it, unless it is not installed or is a
 * Command Line Tools shim on a Mac without them (null either way).
 */
export async function runTool(command: string, args: string[], options: RunOptions & { run?: Runner; resolve?: (command: string) => string | null } = {}): Promise<RunResult | null> {
  const resolved = (options.resolve ?? resolveCommand)(command);
  if (!resolved) return null;
  if (await wouldPromptClt(command, resolved)) return null;
  return (options.run ?? runCommand)(resolved, args, options);
}
