/**
 * Where the desktop's engine keeps its data.
 *
 * OmniRush.ai's engine build keeps its data (the `opencode.db` session store,
 * snapshots, sign-ins, logs) in `<XDG data home>/omnirush`, the directory the
 * OmniRush CLI's engine uses too. The desktop's engine gets a data home of its
 * own under the app's userData directory, so the two never list, resume,
 * upload or repair each other's sessions:
 *
 *   - OMNIRUSH_ENGINE_DATA_HOME, when set (tests, the standalone server);
 *   - else `<userData>/engine-data` inside the desktop app
 *     (OMNIRUSH_DESKTOP_USER_DATA_DIR, which the app sets);
 *   - else none: a standalone server's engine keeps the engine's default.
 *
 * The engine is started with XDG_DATA_HOME set to it. Commands the agent runs
 * get the user's own XDG_DATA_HOME back (OMNIRUSH_USER_XDG_DATA_HOME, applied
 * by the managed-policy plugin's `shell.env` hook).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_XDG_DATA_HOME_ENV = "OMNIRUSH_USER_XDG_DATA_HOME";

/** The user's XDG data home (the engine's default when nothing overrides it). */
export function userDataHome(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return xdg;
  return join(env.HOME?.trim() || homedir(), ".local", "share");
}

/** The desktop engine's own XDG data home, or null when the engine keeps its default. */
export function engineDataHome(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.OMNIRUSH_ENGINE_DATA_HOME?.trim();
  if (explicit) return explicit;
  const userData = env.OMNIRUSH_DESKTOP_USER_DATA_DIR?.trim();
  return userData ? join(userData, "engine-data") : null;
}

/** The engine's data directory: `<engine data home>/omnirush`. */
export function engineDataDir(env: NodeJS.ProcessEnv): string {
  return join(engineDataHome(env) ?? userDataHome(env), "omnirush");
}

/** The environment that gives the engine its data home and remembers the user's (null: none to set). */
export function engineDataEnv(env: NodeJS.ProcessEnv): Record<string, string> | null {
  const home = engineDataHome(env);
  if (!home) return null;
  return { XDG_DATA_HOME: home, [USER_XDG_DATA_HOME_ENV]: userDataHome(env) };
}
