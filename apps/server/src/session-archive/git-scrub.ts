/**
 * Capture v2: the credentials a repository's config can hold are removed
 * from the ARCHIVED copy of that config only; the user's own files are never
 * written. What goes:
 *
 *   - credentials in any URL value or URL subsection (`url`, `pushurl`,
 *     `insteadOf`, `proxy`, `[url "..."]`, `[http "..."]`): all userinfo of
 *     an http(s) URL (`https://user:token@host/x` becomes `https://host/x`),
 *     the password of any other (`ssh://git:pw@host` becomes `ssh://git@host`);
 *   - every `extraheader` (http.extraHeader, http.<url>.extraHeader), which
 *     carries `Authorization: ...` for CI checkouts;
 *   - every `[credential]` / `[credential "<url>"]` section (helpers can be
 *     inline scripts that echo a password, and `username`s);
 *   - any key whose name says it holds a secret (`token`, `password`,
 *     `passwd`, `secret`, `apikey`, `api-key`, `auth`, `cookie`), and the
 *     `http.cookieFile` / `http.sslKey` / `http.sslCertPasswordProtected`
 *     style keys that point at credential files.
 *
 * Removed lines are replaced by a comment, so line counts and section order
 * stay as they were. Identical in the CLI and the desktop app.
 */

/** Archive paths of git config files whose archived copy is scrubbed. */
export function isGitConfigPath(path: string): boolean {
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  if (last !== "config" && last !== "config.worktree") return false;
  const gitIndex = parts.lastIndexOf(".git");
  if (gitIndex === -1) return false;
  const inside = parts.slice(gitIndex + 1, -1);
  // .git/config, .git/config.worktree, .git/worktrees/<name>/config.worktree, .git/modules/<a>/<b>/config
  if (inside.length === 0) return true;
  if (inside[0] === "worktrees" && inside.length === 2) return last === "config.worktree";
  if (inside[0] === "modules") return inside.length >= 2 && inside.every((part) => part !== "objects" && part !== "refs");
  return false;
}

const SECRET_KEY = /^(?:.*(?:token|password|passwd|secret|apikey|api-key|api_key|cookie)|extraheader|cookiefile|sslkey|sslcert|sslcertpasswordprotected|proxyauthmethod)$/i;
const URL_USERINFO = /([a-z][a-z0-9+.-]*):\/\/([^/@\s"]*)@/gi;
const SCP_USERINFO = /^(\s*)([^\s"@/]+)@([^\s"/:]+:)/;

/**
 * Strips credentials from every URL in a config value: all userinfo of an
 * http(s) URL (a token is often the user name there), the password of any
 * other scheme's (`ssh://git:pw@host` keeps `git@`, which says how to log
 * in, not with what), and of the scp form (`user:pw@host:path`).
 */
function stripUserinfo(value: string): string {
  let out = value.replace(URL_USERINFO, (_match, scheme: string, userinfo: string) => {
    if (/^https?$/i.test(scheme)) return `${scheme}://`;
    const user = userinfo.split(":")[0] ?? "";
    return user ? `${scheme}://${user}@` : `${scheme}://`;
  });
  const scp = SCP_USERINFO.exec(out);
  if (scp && scp[2]!.includes(":")) out = out.replace(SCP_USERINFO, (_match, lead: string, userinfo: string, host: string) => `${lead}${userinfo.split(":")[0]}@${host}`);
  return out;
}

export type GitConfigScrub = { text: string; changed: boolean; removed: number };

/** The config text as archived. Never throws; a value it cannot parse is kept only when it holds no URL userinfo. */
export function scrubGitConfig(text: string): GitConfigScrub {
  const lines = text.split("\n");
  let section = "";
  let removed = 0;
  let changed = false;
  let continued = false;
  const out: string[] = [];
  for (const line of lines) {
    if (continued) {
      // The continuation of a removed value (trailing backslash).
      continued = /\\\r?$/.test(line);
      out.push("# [omnirush: removed]");
      removed += 1;
      changed = true;
      continue;
    }
    const header = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      const rest = line.slice(header[0].length).trim();
      // `[section] key = value` on one line: the inline pair is judged like any other.
      const inline = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/.exec(rest);
      if (inline && (section === "credential" || SECRET_KEY.test(inline[1]!))) {
        continued = /\\\r?$/.test(line);
        out.push(`${header[0]} # [omnirush: removed ${section}.${inline[1]!.toLowerCase()}]`);
        removed += 1;
        changed = true;
        continue;
      }
      // A URL subsection (`[url "https://user:token@host/"]`, `[http "..."]`) loses its userinfo too.
      const stripped = stripUserinfo(line);
      if (stripped !== line) {
        changed = true;
        removed += 1;
      }
      out.push(stripped);
      continue;
    }
    const pair = /^(\s*)([A-Za-z][A-Za-z0-9-]*)(\s*(?:=|$))(.*)$/.exec(line);
    if (!pair || /^\s*[#;]/.test(line) || line.trim() === "") {
      out.push(line);
      continue;
    }
    const key = pair[2]!.toLowerCase();
    if (section === "credential" || SECRET_KEY.test(key)) {
      continued = /\\\r?$/.test(line);
      out.push(`${pair[1]}# [omnirush: removed ${section ? `${section}.` : ""}${key}]`);
      removed += 1;
      changed = true;
      continue;
    }
    const stripped = stripUserinfo(line);
    if (stripped !== line) {
      changed = true;
      removed += 1;
    }
    out.push(stripped);
  }
  return { text: out.join("\n"), changed, removed };
}
