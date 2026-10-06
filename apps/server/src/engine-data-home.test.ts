import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { engineDataDir, engineDataEnv, engineDataHome, userDataHome } from "./engine-data-home.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";

describe("the desktop engine's data home", () => {
  test("under the app's userData, apart from the CLI's engine data", () => {
    const env = { HOME: "/home/u", OMNIRUSH_DESKTOP_USER_DATA_DIR: "/home/u/.config/omnirush.ai" };
    expect(engineDataHome(env)).toBe("/home/u/.config/omnirush.ai/engine-data");
    expect(engineDataDir(env)).toBe("/home/u/.config/omnirush.ai/engine-data/omnirush");
    expect(engineDataEnv(env)).toEqual({ XDG_DATA_HOME: "/home/u/.config/omnirush.ai/engine-data", OMNIRUSH_USER_XDG_DATA_HOME: "/home/u/.local/share" });
    expect(userDataHome({ HOME: "/home/u", XDG_DATA_HOME: "/x/data" })).toBe("/x/data");
  });

  test("an explicit OMNIRUSH_ENGINE_DATA_HOME wins; without either the engine keeps its default", () => {
    expect(engineDataHome({ OMNIRUSH_ENGINE_DATA_HOME: "/e", OMNIRUSH_DESKTOP_USER_DATA_DIR: "/u" })).toBe("/e");
    expect(engineDataEnv({ HOME: "/home/u" })).toBeNull();
    expect(engineDataDir({ HOME: "/home/u" })).toBe("/home/u/.local/share/omnirush");
  });

  test("the managed engine starts with it, and remembers the user's for the commands it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-data-home-"));
    try {
      const dump = join(dir, "env.json");
      const bin = join(dir, "engine.mjs");
      writeFileSync(bin, [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ data: process.env.XDG_DATA_HOME, user: process.env.OMNIRUSH_USER_XDG_DATA_HOME }));`,
        "console.log('opencode server listening on http://127.0.0.1:' + process.argv[process.argv.indexOf('--port') + 1]);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));
      chmodSync(bin, 0o755);
      const server = await createManagedOpencodeServer({
        bin,
        cwd: dir,
        env: { HOME: dir, XDG_DATA_HOME: join(dir, "user-data"), OMNIRUSH_ENGINE_DATA_HOME: join(dir, "engine-data") },
      });
      await server.close();
      expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual({ data: join(dir, "engine-data"), user: join(dir, "user-data") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
