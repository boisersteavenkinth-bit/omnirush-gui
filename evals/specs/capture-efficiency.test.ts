import { expect } from "vitest";
import { startCaptureEfficiencyLab, type CaptureEfficiencyAttempt, type CaptureEfficiencyLab, type CaptureEfficiencyWitness } from "@omnirush/labs";
import { eventually, needs, test } from "@omnirush/testkit";

const SESSION_A = "session-a-0001";
const SESSION_B = "session-b-0001";

async function postControl(lab: CaptureEfficiencyLab, path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${lab.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lab.controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  expect(response.status, text).toBe(202);
}

function attemptsFor(witness: CaptureEfficiencyWitness, sessionId: string): CaptureEfficiencyAttempt[] {
  return witness.attempts.filter((attempt) => attempt.sessionId === sessionId);
}

function acceptedTrace(witness: CaptureEfficiencyWitness, sessionId: string): CaptureEfficiencyAttempt {
  const trace = attemptsFor(witness, sessionId).find((attempt) => attempt.snapshotType === "trace" && attempt.status === 201);
  if (!trace) throw new Error(`accepted trace for ${sessionId} was not observed`);
  return trace;
}

test("capture worker uploads ordered, scoped trace artifacts at the HTTP collector boundary", { timeout: 60_000 }, async ({ evidence }) => {
  needs({ placement: "local", commands: ["bun"] });
  const lab = await startCaptureEfficiencyLab();
  try {
    const initial = await lab.witness();
    const unauthorized = await fetch(`${lab.baseUrl}/witness`, { signal: AbortSignal.timeout(5_000) });
    expect(unauthorized.status).toBe(401);
    expect((await lab.witness()).attempts).toHaveLength(initial.attempts.length);
    evidence.recordAssertionEvidence(
      "Capture controls and collector witness require the lab bearer",
      "An unauthenticated HTTP witness request returned 401 and did not alter the outbound request record.",
      true,
    );

    await postControl(lab, "/control/start", { sessionId: SESSION_A, actor: "actor-a", workspace: "workspace-a" });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_A,
      type: "engine.request",
      data: { actor: "actor-a", workspace: "workspace-a", marker: "request-a" },
    });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_A,
      type: "turn.messages",
      data: {
        actor: "actor-a",
        workspace: "workspace-a",
        messages: [{ role: "assistant", parts: [{ type: "tool", tool: "apply_patch", state: { input: { path: "notes-a.txt" } } }] }],
      },
    });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_A,
      type: "turn.completed",
      data: { actor: "actor-a", workspace: "workspace-a", turn: 1 },
    });
    await postControl(lab, "/control/flush", { sessionId: SESSION_A });

    await postControl(lab, "/control/start", { sessionId: SESSION_B, actor: "actor-b", workspace: "workspace-b" });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_B,
      type: "engine.request",
      data: { actor: "actor-b", workspace: "workspace-b", marker: "request-b" },
    });
    await postControl(lab, "/control/trace", {
      sessionId: SESSION_B,
      type: "turn.completed",
      data: { actor: "actor-b", workspace: "workspace-b", turn: 1 },
    });
    await postControl(lab, "/control/flush", { sessionId: SESSION_B });

    await postControl(lab, "/control/complete", { sessionId: SESSION_A });
    await postControl(lab, "/control/complete", { sessionId: SESSION_B });

    const witness = await eventually(() => lab.witness(), {
      within: 20_000,
      intervalMs: 100,
      label: "capture worker collector requests",
      until: (current) => current.attempts.length === 7
        && current.attempts.filter((attempt) => attempt.status === 201).length === 6,
    });

    expect(witness.modes).toEqual(["worker", "worker"]);
    const traceA = acceptedTrace(witness, SESSION_A);
    const traceB = acceptedTrace(witness, SESSION_B);
    const traceAttemptsA = attemptsFor(witness, SESSION_A).filter((attempt) => attempt.snapshotType === "trace");
    const traceAttemptsB = attemptsFor(witness, SESSION_B).filter((attempt) => attempt.snapshotType === "trace");

    expect(traceAttemptsA.map((attempt) => [attempt.status, attempt.schemaVersion])).toEqual([[422, 3], [201, 2]]);
    expect(traceAttemptsB.map((attempt) => [attempt.status, attempt.schemaVersion])).toEqual([[201, 3]]);
    expect(traceB.filePaths).toEqual([]);
    expect(traceB.traceFileCount).toBe(0);
    expect(traceB.traceTypes).toEqual(["engine.request", "turn.completed"]);
    expect(traceA.schemaVersion).toBe(2);
    expect(traceA.traceTypes).toEqual(["engine.request", "turn.messages", "turn.completed"]);
    expect(traceA.traceFileCount).toBe(1);
    expect(traceA.traceFileEventTypes).toEqual(traceA.traceTypes);
    evidence.recordAssertionEvidence(
      "Canonical schema 3 is emitted without a duplicate trace artifact",
      "The accepted actor-b trace request used schema 3 with files=[] and no legacy trace file; its ordered events were emitted once.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Unsupported schema 3 downgrades the same ordered batch to legacy schema 2",
      "Actor-a received one 422 unsupported-schema attempt followed by one schema-2 trace with exactly one trace.json whose event order matched the canonical batch.",
      true,
    );

    const actorAAttempts = attemptsFor(witness, SESSION_A).filter((attempt) => attempt.status === 201);
    const actorBAttempts = attemptsFor(witness, SESSION_B).filter((attempt) => attempt.status === 201);
    expect(actorAAttempts.map((attempt) => attempt.snapshotType)).toEqual(["start", "trace", "end"]);
    expect(actorBAttempts.map((attempt) => attempt.snapshotType)).toEqual(["start", "trace", "end"]);
    expect(actorAAttempts.every((attempt) => attempt.workspaceRoot === "workspace-a")).toBe(true);
    expect(actorBAttempts.every((attempt) => attempt.workspaceRoot === "workspace-b")).toBe(true);
    expect(actorAAttempts.every((attempt) => attempt.actorMarkers.every((actor) => actor === "actor-a"))).toBe(true);
    expect(actorBAttempts.every((attempt) => attempt.actorMarkers.every((actor) => actor === "actor-b"))).toBe(true);
    expect(actorAAttempts[0]?.filePaths).toContain("notes-a.txt");
    expect(actorAAttempts[0]?.filePaths).not.toContain("notes-b.txt");
    expect(actorBAttempts[0]?.filePaths).toContain("notes-b.txt");
    expect(actorBAttempts[0]?.filePaths).not.toContain("notes-a.txt");
    expect(traceA.actorMarkers).toEqual(["actor-a", "actor-a", "actor-a"]);
    expect(traceB.actorMarkers).toEqual(["actor-b", "actor-b"]);
    expect(witness.capabilityCalls).toEqual({ "actor-a": 1, "actor-b": 1 });
    evidence.recordAssertionEvidence(
      "Capture records preserve completion order and actor/workspace scope",
      "Each synthetic session produced start, trace, and end in order; trace markers and workspace roots stayed within their owning actor, with one capability probe per worker.",
      true,
    );
  } finally {
    await lab.stop();
  }
});
