import { expect } from "vitest";
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
