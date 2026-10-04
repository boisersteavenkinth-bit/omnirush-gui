import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DOWNLOAD_URL,
  compareVersions,
  createUpdateGate,
  parseClientUpdate,
  parseUpdateRequiredHeader,
} from "./update-gate.mjs";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const DEADLINE = "2026-10-04T17:12:00.000Z";

function gate(appVersion = "3.0.2", now = () => NOW) {
  const changes = [];
  const subject = createUpdateGate({ appVersion, now, onChange: (state) => changes.push(state) });
  return { subject, changes };
}

test("client_update for the GUI is parsed; the CLI's is ignored", () => {
  assert.deepEqual(parseClientUpdate({
    required: true,
    product: "gui",
    current: "3.0.2",
    minimum: "3.1.0",
    deadline: "2026-10-04T17:12:00Z",
    blocked: false,
    message: "Update to 3.1.0",
    download_url: "https://omnirush.ai/download",
  }), {
    required: true,
    blocked: false,
    current: "3.0.2",
    minimum: "3.1.0",
    deadline: DEADLINE,
    message: "Update to 3.1.0",
    downloadUrl: "https://omnirush.ai/download",
  });
  assert.equal(parseClientUpdate({ required: true, product: "cli", minimum: "1.0.0" }), null);
  assert.equal(parseClientUpdate(null), null);
  assert.equal(parseClientUpdate("required"), null);
  const loose = parseClientUpdate({ required: "yes", deadline: "soon", download_url: "javascript:alert(1)" });
  assert.equal(loose.required, false);
  assert.equal(loose.deadline, null);
  assert.equal(loose.downloadUrl, null);
});

test("the update-required header gives the minimum and the deadline", () => {
  assert.deepEqual(parseUpdateRequiredHeader("3.1.0; deadline=2026-10-04T17:12:00Z"), { minimum: "3.1.0", deadline: DEADLINE });
  assert.deepEqual(parseUpdateRequiredHeader("v3.1.0"), { minimum: "3.1.0", deadline: null });
  assert.deepEqual(parseUpdateRequiredHeader("3.1.0;Deadline=\"2026-10-04T17:12:00Z\""), { minimum: "3.1.0", deadline: DEADLINE });
  assert.equal(parseUpdateRequiredHeader(""), null);
  assert.equal(parseUpdateRequiredHeader("soon; deadline=2026-10-04T17:12:00Z"), null);
});

test("versions compare numerically, a prerelease below its release", () => {
  assert.equal(compareVersions("3.0.2", "3.1.0"), -1);
  assert.equal(compareVersions("3.10.0", "3.9.9"), 1);
  assert.equal(compareVersions("v3.1.0", "3.1"), 0);
  assert.equal(compareVersions("3.1.0-rc.1", "3.1.0"), -1);
  assert.equal(compareVersions("dev", "3.1.0"), null);
});

test("required before the deadline shows the banner state; the deadline passing blocks", () => {
  let now = NOW;
  const { subject, changes } = gate("3.0.2", () => now);
  const state = subject.signal({ kind: "profile", clientUpdate: parseClientUpdate({
    required: true, product: "gui", minimum: "3.1.0", deadline: DEADLINE, download_url: "https://omnirush.ai/dl",
  }) });
  assert.equal(state.status, "required");
  assert.equal(state.minimum, "3.1.0");
  assert.equal(state.deadline, DEADLINE);
  assert.equal(state.downloadUrl, "https://omnirush.ai/dl");
  assert.equal(state.source, "profile");
  now = Date.parse(DEADLINE) + 1;
  assert.equal(subject.state().status, "blocked");
  assert.equal(changes.length, 1);
  subject.dispose();
});

test("client_update.blocked, or a 426 seen, blocks; the server lifting it clears the gate", () => {
  const { subject, changes } = gate();
  assert.equal(subject.signal({ kind: "profile", clientUpdate: parseClientUpdate({ required: true, blocked: true, minimum: "3.1.0" }) }).status, "blocked");
  assert.equal(subject.signal({ kind: "profile", clientUpdate: parseClientUpdate({ required: false }) }).status, "none");
  const rejected = subject.signal({ kind: "rejection", message: "Update OmniRush.ai" });
  assert.equal(rejected.status, "blocked");
  assert.equal(rejected.message, "Update OmniRush.ai");
  assert.equal(rejected.source, "rejection");
  // /device/me without client_update is authoritative too.
  assert.equal(subject.signal({ kind: "profile", clientUpdate: null }).status, "none");
  assert.deepEqual(changes.map((state) => state.status), ["blocked", "none", "blocked", "none"]);
  subject.dispose();
});

test("the header alone makes the update required, and never unblocks", () => {
  const { subject } = gate();
  const required = subject.signal({ kind: "header", value: `3.1.0; deadline=${DEADLINE}` });
  assert.equal(required.status, "required");
  assert.equal(required.source, "header");
  subject.signal({ kind: "rejection", message: null });
  assert.equal(subject.signal({ kind: "header", value: `3.1.0; deadline=${DEADLINE}` }).status, "blocked");
  assert.equal(subject.signal({ kind: "header", value: "garbage" }).status, "blocked");
  subject.dispose();
});

test("a minimum this version already meets never gates it", () => {
  const { subject, changes } = gate("3.1.0");
  assert.equal(subject.signal({ kind: "header", value: `3.1.0; deadline=${DEADLINE}` }).status, "none");
  assert.equal(subject.signal({ kind: "profile", clientUpdate: parseClientUpdate({ required: true, blocked: true, minimum: "3.0.9" }) }).status, "none");
  assert.equal(changes.length, 0);
  assert.equal(subject.state().downloadUrl, DEFAULT_DOWNLOAD_URL);
  subject.dispose();
});

test("the state flips to blocked by itself when the deadline passes while the app is open", async () => {
  const deadline = new Date(Date.now() + 30).toISOString();
  const changes = [];
  const subject = createUpdateGate({ appVersion: "3.0.2", onChange: (state) => changes.push(state.status) });
  subject.signal({ kind: "header", value: `3.1.0; deadline=${deadline}` });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(changes, ["required", "blocked"]);
  subject.dispose();
});
