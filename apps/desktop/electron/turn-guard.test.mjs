import assert from "node:assert/strict";
import test from "node:test";

import { TURN_GUARD_BUTTONS, TURN_GUARD_DETAIL, TURN_GUARD_TITLE, createTurnGuard } from "./turn-guard.mjs";

function fakeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function setup(responses) {
  const asked = [];
  const guard = createTurnGuard({
    getWindow: () => /** @type {any} */ ("win"),
    showMessageBox: async (win, options) => {
      asked.push({ win, options });
      return { response: responses.shift() ?? 0 };
    },
  });
  return { guard, asked };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("no turn running: quit and close go ahead without asking", () => {
  const { guard, asked } = setup([]);
  const event = fakeEvent();
  assert.equal(guard.guardQuit(event, () => assert.fail("no re-quit")), true);
  assert.equal(guard.guardClose(fakeEvent(), () => assert.fail("no re-close")), true);
  assert.equal(event.prevented, false);
  assert.equal(asked.length, 0);
});

test("a turn running: quitting asks, with Wait for it as the default", async () => {
  const { guard, asked } = setup([0]);
  guard.setTurnRunning(true);
  const event = fakeEvent();
  let quits = 0;
  assert.equal(guard.guardQuit(event, () => { quits += 1; }), false);
  assert.equal(event.prevented, true);
  await settle();
  assert.equal(asked.length, 1);
  const { options } = asked[0];
  assert.equal(options.message, "A turn is still running.");
  assert.equal(options.detail, "Quit now and this session won't count as a Good session ★.");
  assert.deepEqual(options.buttons, ["Wait for it", "Quit anyway"]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(quits, 0, "Wait for it keeps the app open");
});

test("Quit anyway quits, and the second before-quit goes through", async () => {
  const { guard, asked } = setup([1]);
  guard.setTurnRunning(true);
  let quits = 0;
  guard.guardQuit(fakeEvent(), () => { quits += 1; });
  await settle();
  assert.equal(quits, 1);
  const again = fakeEvent();
  assert.equal(guard.guardQuit(again, () => assert.fail("asked twice")), true);
  assert.equal(again.prevented, false);
  assert.equal(asked.length, 1);
});

test("closing the window asks the same; Quit anyway closes it and the quit that follows is not asked again", async () => {
  const { guard, asked } = setup([1]);
  guard.setTurnRunning(true);
  let closes = 0;
  const event = fakeEvent();
  assert.equal(guard.guardClose(event, () => { closes += 1; }), false);
  assert.equal(event.prevented, true);
  await settle();
  assert.equal(closes, 1);
  assert.equal(guard.guardQuit(fakeEvent(), () => assert.fail("asked twice")), true);
  assert.equal(asked.length, 1);
});

test("a close and a quit while the dialog is open share one dialog", async () => {
  const { guard, asked } = setup([0]);
  guard.setTurnRunning(true);
  guard.guardClose(fakeEvent(), () => assert.fail("waited"));
  guard.guardQuit(fakeEvent(), () => assert.fail("waited"));
  await settle();
  assert.equal(asked.length, 1);
});

test("the turn finishing while asked: later quits go through; a reopened window asks again", async () => {
  const { guard, asked } = setup([1, 0]);
  guard.setTurnRunning(true);
  guard.guardClose(fakeEvent(), () => undefined);
  await settle();
  guard.reset();
  assert.equal(guard.guardClose(fakeEvent(), () => assert.fail("waited")), false);
  await settle();
  assert.equal(asked.length, 2);
  guard.setTurnRunning(false);
  assert.equal(guard.guardQuit(fakeEvent(), () => undefined), true);
});

test("only a strict true marks a turn running", () => {
  const { guard } = setup([]);
  assert.equal(guard.setTurnRunning("yes"), false);
  assert.equal(guard.setTurnRunning(true), true);
  assert.equal(guard.isTurnRunning(), true);
});

test("constants", () => {
  assert.equal(TURN_GUARD_TITLE, "A turn is still running.");
  assert.match(TURN_GUARD_DETAIL, /Good session ★/);
  assert.deepEqual([...TURN_GUARD_BUTTONS], ["Wait for it", "Quit anyway"]);
});
