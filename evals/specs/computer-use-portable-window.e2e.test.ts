import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, waitFor } from "@omnirush/behaviors";
import { browserScript } from "@omnirush/testkit";
import { spec } from "@omnirush/testkit";
import { portableComputerUseWorld, toolState } from "../worlds/computer-use.ts";

const test = spec.world(portableComputerUseWorld, { timeout: 180_000 });

test("Windows and Linux X11 Computer Use keeps native input within the approved window", async ({ world, step }) => {
  await step("Desktop readiness exposes supported modes and discovery reveals no window contents", async () => {
    expect(world.permissions).toMatchObject({ ok: true, supported: true, modes: ["observe", "control"], backgroundControl: false });
    const discovered = toolState(await world.call("computer_discover"));
    expect(discovered.background_control).toBe(false);
    expect(JSON.stringify(discovered)).not.toContain("Initial draft");
    expect(toolState(await world.call("computer_observe", { session_id: "unapproved" })).code).toBe("session_unavailable");
    expect(toolState(await world.call("computer_open_session", { app_id: world.appId, mode: "assist", purpose: "Unsupported controls" })).code).toBe("unsupported_mode");
    expect(await world.state()).toEqual([{ count: 0, draft: "Initial draft" }, { count: 0, draft: "Initial draft" }]);
  });
  const session = await step("Only a person can approve a particular native window", async () => {
    const pending = world.call("computer_open_session", { app_id: world.appId, pid: world.pid, mode: "control", purpose: "Increment a disposable counter and edit a disposable draft." });
    await expect.poll(async () => JSON.stringify(await world.hostState())).toContain('"phase":"approval"');
    await expect(world.raw("omnirush/ui", { action: "approve" })).rejects.toThrow("Method not available to the agent");
    expect(toolState(await world.peerCall("computer_open_session", { app_id: world.appId, mode: "observe", purpose: "Peer request" })).code).toBe("session_busy");
    expect(await world.state()).toEqual([{ count: 0, draft: "Initial draft" }, { count: 0, draft: "Initial draft" }]);
    await world.approve();
    const opened = toolState(await pending);
    expect(opened).toMatchObject({ ok: true, window_title: "Workspace window", mode: "control", background_control: false });
    expect(typeof opened.session_id).toBe("string");
    return opened.session_id;
  });
  await step("A second client cannot borrow the grant or read the approved window", async () => {
    expect(toolState(await world.peerCall("computer_observe", { session_id: session })).code).toBe("session_unavailable");
    expect(toolState(await world.peerCall("computer_session_status", { session_id: session })).code).toBe("session_unavailable");
  });
  await step("Real native mouse input increments only the selected window", async () => {
    const observedReply = await world.call("computer_observe", { session_id: session });
    expect(observedReply).toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]) });
    const observed = toolState(observedReply);
    expect(observed.ok, JSON.stringify(observed)).toBe(true);
    const point = await world.point(observed, 150, 95);
    const acted = toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "first-click", action: { type: "click", ...point } }));
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, dispatched: true });
    await expect.poll(() => world.state()).toEqual([{ count: 1, draft: "Initial draft" }, { count: 0, draft: "Initial draft" }]);
    expect(toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "repeat-observation", action: { type: "click", ...point } })).code).toBe("stale_observation");
  });
  await step("Native keyboard input edits only the selected window", async () => {
    const act = async (request: string, action: object) => {
      const observed = toolState(await world.call("computer_observe", { session_id: session }));
      expect(observed.ok, JSON.stringify(observed)).toBe(true);
      const result = toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: request, action }));
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, dispatched: true });
    };
    const observed = toolState(await world.call("computer_observe", { session_id: session }));
    const point = await world.point(observed, 150, 180);
    expect(toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "focus-draft", action: { type: "click", ...point } })).ok).toBe(true);
    await act("select-draft", { type: "key", key: "a", modifiers: ["ctrl"] });
    await act("write-draft", { type: "type", text: "OmniRush 123!" });
    await expect.poll(() => world.state()).toEqual([{ count: 1, draft: "OmniRush 123!" }, { count: 0, draft: "Initial draft" }]);
  });
  await step("Changed pixels and out-of-window coordinates cannot dispatch input", async () => {
    const observed = toolState(await world.call("computer_observe", { session_id: session }));
    await world.change();
    expect(toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "stale-click", action: { type: "click", x: 1, y: 1 } }))).toMatchObject({ ok: false, code: "stale_observation", may_have_acted: false });
    const fresh = toolState(await world.call("computer_observe", { session_id: session }));
    expect(toolState(await world.call("computer_act", { session_id: session, observation_id: fresh.observation_id, request_id: "outside-click", action: { type: "click", x: -1, y: 20 } }))).toMatchObject({ ok: false, code: "invalid_action", may_have_acted: false });
    expect(await world.state()).toEqual([{ count: 1, draft: "Changed by person" }, { count: 0, draft: "Initial draft" }]);
  });
  await step("Focus moving to another window stops keyboard input", async () => {
    const observed = toolState(await world.call("computer_observe", { session_id: session }));
    await world.focusOther();
    const result = toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "wrong-focus", action: { type: "type", text: "Forbidden" } }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: "focus_changed" });
    expect(toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("paused");
    expect(await world.state()).toEqual([{ count: 1, draft: "Changed by person" }, { count: 0, draft: "Initial draft" }]);
    await world.approve("resume");
  });
  await step("Take over pauses control and only the person can continue", async () => {
    const observed = toolState(await world.call("computer_observe", { session_id: session }));
    await world.previewAction("pause");
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("paused");
    expect(toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "paused-input", action: { type: "type", text: "Forbidden" } })).code).toBe("session_paused");
    await expect(world.raw("omnirush/ui", { action: "resume" })).rejects.toThrow("Method not available to the agent");
    await world.approve("resume");
    expect(toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("active");
    expect(toolState(await world.call("computer_act", { session_id: session, observation_id: observed.observation_id, request_id: "invalidated-input", action: { type: "type", text: "Forbidden" } })).code).toBe("stale_observation");
  });
  await step("Stop in the native preview revokes access and leaves both windows intact", async () => {
    await world.previewAction("stop");
    expect(toolState(await world.call("computer_observe", { session_id: session })).code).toBe("session_unavailable");
    expect(await world.hostState()).toEqual([]);
    expect(await world.state()).toEqual([{ count: 1, draft: "Changed by person" }, { count: 0, draft: "Initial draft" }]);
  });
  await step("Read-only approval never permits mouse or keyboard input", async () => {
    const pending = world.call("computer_open_session", { app_id: world.appId, pid: world.pid, mode: "observe", purpose: "Read the disposable fixture." });
    await world.approve();
    const opened = toolState(await pending);
    expect(opened.ok).toBe(true);
    const observed = toolState(await world.call("computer_observe", { session_id: opened.session_id, include_image: false }));
    expect(observed.ok).toBe(true);
    expect(toolState(await world.call("computer_act", { session_id: opened.session_id, observation_id: observed.observation_id, request_id: "read-only-type", action: { type: "type", text: "Forbidden" } })).code).toBe("scope_denied");
    await world.cover();
    const covered = await world.call("computer_observe", { session_id: opened.session_id });
    expect(toolState(covered).ok, JSON.stringify(toolState(covered))).toBe(true);
    expect(await world.imagePixel(covered)).toMatchObject({ rgb: [238, 238, 238] });
    await world.closeClient();
    await expect.poll(() => world.hostState()).toEqual([]);
    expect(await world.state()).toEqual([{ count: 1, draft: "Changed by person" }, { count: 0, draft: "Initial draft" }]);
  });
});


test("Computer Use setup and approval work from the main app on Windows and Linux X11", async ({ world, step }) => {
  await using app = await world.desktop();
  const { workspaceId } = await createAndSelectWorkspace(app, { path: world.workspacePath });
  await step("Setup explains foreground control and offers the supported modes", async () => {
    await evalIn(app, browserScript((value) => (location.hash = value), [`#/workspace/${workspaceId}/extensions/computer-use`]));
    await waitFor(app, () => document.body.innerText.includes("Permissions are ready. Enable Computer Use for this workspace."), { timeoutMs: 60_000 });
    expect(await evalIn(app, () => document.body.innerText.includes("Work through accessible controls"))).toBe(false);
    expect(await evalIn(app, () => document.body.innerText.includes("foreground"))).toBe(true);
    await evalIn(app, () => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Enable Computer Use")?.click());
    await waitFor(app, () => document.body.innerText.includes("Ready · app access is approved when a session starts"), { timeoutMs: 60_000 });
  });
  const command = await evalIn(app, () => window.__OMNIRUSH_ELECTRON__.invokeDesktop("getComputerUseMcpCommand"));
  const environment = await evalIn(app, () => window.__OMNIRUSH_ELECTRON__.invokeDesktop("getComputerUseMcpEnvironment"));
  await step("Copy CLI connection produces a usable local command without the discovery secret", async () => {
    await evalIn(app, () => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Copy CLI connection")?.click());
    await waitFor(app, () => document.body.innerText.includes("CLI connection copied"));
    const copied = await evalIn(app, async () => navigator.clipboard.readText(), { awaitPromise: true });
    expect(typeof copied).toBe("string");
    const config = JSON.parse(String(copied));
    expect(config).toEqual({ mcpServers: { "computer-use": { command: Array.isArray(command) ? command[0] : "", args: Array.isArray(command) ? command.slice(1) : [], env: environment } } });
    expect(copied).not.toContain('"token"');
  });
  await using client = await world.hostedClient(command, environment);
  const session = await step("The app's window picker grants the selected native window", async () => {
    const pending = client.call("computer_open_session", { app_id: world.appId, pid: world.pid, mode: "control", purpose: "Test the main app approval with a disposable window." });
    await waitFor(app, () => Boolean(document.querySelector('select[aria-label="Window to allow"]')));
    await evalIn(app, () => {
      const picker = document.querySelector('select[aria-label="Window to allow"]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error("Missing window picker");
      const option = [...picker.options].find((option) => option.textContent === "Workspace window");
      if (!option) throw new Error("Missing fixture window");
      picker.value = option.value; picker.dispatchEvent(new Event("change", { bubbles: true }));
      [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Allow and start")?.click();
    });
    const result = toolState(await pending);
    expect(result).toMatchObject({ ok: true, window_title: "Workspace window", mode: "control" });
    return result.session_id;
  });
  await step("The main app can stop access without relying on the agent", async () => {
    expect(toolState(await client.call("computer_observe", { session_id: session })).ok).toBe(true);
    await evalIn(app, async () => {
      const states = await window.__OMNIRUSH_ELECTRON__.invokeDesktop("getComputerUseState");
      if (!Array.isArray(states) || !states[0]) throw new Error("No active desktop session");
      await window.__OMNIRUSH_ELECTRON__.invokeDesktop("computerUseAction", { connectionId: states[0].connectionId, id: states[0].id, action: "stop" });
    }, { awaitPromise: true });
    expect(toolState(await client.call("computer_session_status", { session_id: session })).code).toBe("session_unavailable");
    expect(await world.state()).toEqual([{ count: 0, draft: "Initial draft" }, { count: 0, draft: "Initial draft" }]);
  });
});
