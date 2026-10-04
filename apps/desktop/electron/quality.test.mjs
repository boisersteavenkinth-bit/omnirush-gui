import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopOmniRushAccountStore } from "./omnirush-account.mjs";
import { parseAccountQuality, parseSpinResult, spinIdempotencyKey, spinRefusal } from "./quality.mjs";

const GATEWAY = "http://localhost:8090/omnirush/v1";
const SEGMENTS = [
  { tokens: 250000, weight: 35 }, { tokens: 500000, weight: 30 }, { tokens: 1000000, weight: 20 },
  { tokens: 2000000, weight: 10 }, { tokens: 5000000, weight: 4 }, { tokens: 10000000, weight: 1 },
];
const QUALITY = {
  tier: "gold",
  score: 0.52,
  tokens_multiplier: 1,
  spins_available: 2,
  repro_spins_available: 1,
  spins_expire_at: "2026-10-06T10:00:00Z",
  next_tier_hint: "Keep it up.",
  tips: ["Start omnirush inside the project folder.", "", 7],
  notice: { id: "spins-1", title: "You earned 2 spins", body: "Nice work." },
  notices: [{ id: "spins-1", kind: "spins", title: "You earned 2 spins", body: "Nice work." }],
  mode: "enforce",
  resting: false,
  preview: false,
  streak_days: 4,
  streak_multiplier: 1,
  streak_next: { days: 7, bonus_spins: 2 },
  next_spin_hint: { progress: 0.6, text: "Add tests to earn a spin.", session_id: "ses_1" },
  biggest_win_today: { tokens: 10000000, at: "2026-10-04T09:00:00Z" },
  nudge: null,
};
const SPIN = {
  tokens: 1000000, prize_tokens: 1000000, segment_index: 2, segments: SEGMENTS, preview: false, capped: false,
  reproducible: true, already_spun: false, spun_at: "2026-10-04T12:00:00Z", spins_available: 1, pot_balance: 12500000,
  celebrate: "none", near_miss: false, jackpot_tokens: 10000000, streak_days: 4,
};

function testStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
    decryptStringAsync: async (value) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
  };
}

async function signedInStore(fetchImpl, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-quality-"));
  const store = createDesktopOmniRushAccountStore({
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => testStorage(),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { OMNIRUSH_DEV_MODE: "1" },
    sleep: async () => undefined,
    execFileImpl: async (file) => { throw new Error(`unexpected ${file}`); },
    clientVersion: "3.2.0",
    fetchImpl,
    ...overrides,
  });
  await store.save({ gatewayUrl: GATEWAY, accessToken: "access-1", refreshToken: "refresh-1" });
  return store;
}

test("quality: null, missing or an unknown tier means the feature is off", () => {
  assert.equal(parseAccountQuality(null), null);
  assert.equal(parseAccountQuality(undefined), null);
  assert.equal(parseAccountQuality({ tier: "platinum" }), null);
  assert.equal(parseAccountQuality([]), null);
});

test("quality block parses every field, including revision 2", () => {
  const quality = parseAccountQuality(QUALITY);
  assert.deepEqual(quality, {
    tier: "gold",
    score: 0.52,
    tokensMultiplier: 1,
    spinsAvailable: 2,
    reproSpinsAvailable: 1,
    spinsExpireAt: "2026-10-06T10:00:00Z",
    nextTierHint: "Keep it up.",
    tips: ["Start omnirush inside the project folder."],
    notice: { id: "spins-1", kind: "spins", title: "You earned 2 spins", body: "Nice work." },
    notices: [{ id: "spins-1", kind: "spins", title: "You earned 2 spins", body: "Nice work." }],
    mode: "enforce",
    resting: false,
    preview: false,
    streakDays: 4,
    streakMultiplier: 1,
    streakNext: { days: 7, bonusSpins: 2 },
    nextSpinHint: { progress: 0.6, text: "Add tests to earn a spin.", sessionId: "ses_1" },
    biggestWinToday: { tokens: 10000000, at: "2026-10-04T09:00:00Z" },
    nudge: null,
  });
  // A server without `notices` still has its one `notice`.
  const legacy = parseAccountQuality({ tier: "limited", tokens_multiplier: 0.3, notice: { id: "n", title: "Hi" } });
  assert.equal(legacy.notices[0].id, "n");
  assert.equal(legacy.tokensMultiplier, 0.3);
  assert.equal(legacy.preview, false);
});

test("a spin answer must name a segment the wheel can land on", () => {
  const spin = parseSpinResult(SPIN);
  assert.equal(spin.segmentIndex, 2);
  assert.equal(spin.prizeTokens, 1000000);
  assert.equal(spin.reproducible, true);
  assert.equal(spin.celebrate, "none");
  assert.equal(spin.jackpotTokens, 10000000);
  assert.equal(parseSpinResult({ ...SPIN, segment_index: 6 }), null);
  assert.equal(parseSpinResult({ ...SPIN, segment_index: -1 }), null);
  assert.equal(parseSpinResult({ ...SPIN, segments: [] }), null);
  assert.equal(parseSpinResult({ ...SPIN, celebrate: "party" }).celebrate, "none");
});

test("409 details map to refusals; anything else is not one", () => {
  assert.equal(spinRefusal({ detail: "no_spins" }), "no_spins");
  assert.equal(spinRefusal({ detail: "wheel_resting" }), "wheel_resting");
  assert.equal(spinRefusal({ detail: { code: "quality_rewards_off" } }), "quality_rewards_off");
  assert.equal(spinRefusal({ detail: "nope" }), null);
  assert.equal(spinRefusal(null), null);
});

test("the idempotency key is the caller's, or a fresh UUID when it is unusable", () => {
  assert.equal(spinIdempotencyKey("b3f1c1f2-6a7e-4c1a-9a43-0d8f8e9a1b2c"), "b3f1c1f2-6a7e-4c1a-9a43-0d8f8e9a1b2c");
  assert.match(spinIdempotencyKey("x".repeat(65)), /^[0-9a-f-]{36}$/);
  assert.match(spinIdempotencyKey(undefined), /^[0-9a-f-]{36}$/);
});

test("the profile carries `quality` to the renderer, null when the server sends none", async () => {
  let quality = QUALITY;
  const store = await signedInStore(async () => Response.json({ email: "person@example.com", status: "active", quality }));
  assert.equal((await store.status()).quality.tier, "gold");
  quality = null;
  assert.equal((await store.status()).quality, null);
});

test("spin: POST with the device credential, the click's key and X-OmniRush-Client", async () => {
  const seen = [];
  const store = await signedInStore(async (url, init = {}) => {
    const headers = new Headers(init.headers);
    seen.push({
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
      client: headers.get("x-omnirush-client"),
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
    });
    return Response.json(SPIN);
  });
  const outcome = await store.spinQuality({ idempotencyKey: "key-123" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.spin.segmentIndex, 2);
  assert.deepEqual(seen, [{
    url: "http://localhost:8090/omnirush/me/quality/spin",
    method: "POST",
    body: { idempotency_key: "key-123" },
    client: "gui/3.2.0",
    authorization: "Bearer access-1",
    contentType: "application/json",
  }]);
});

test("spin: a 409 comes back as its refusal, never as a thrown error", async () => {
  for (const detail of ["no_spins", "wheel_resting", "quality_rewards_off"]) {
    const store = await signedInStore(async () => Response.json({ detail }, { status: 409 }));
    assert.deepEqual(await store.spinQuality({ idempotencyKey: "k" }), { ok: false, reason: detail, status: 409 });
  }
  const odd = await signedInStore(async () => Response.json({ detail: "busy" }, { status: 409 }));
  assert.deepEqual(await odd.spinQuality({ idempotencyKey: "k" }), { ok: false, reason: "failed", status: 409 });
  const broken = await signedInStore(async () => Response.json({ detail: "boom" }, { status: 500 }));
  assert.deepEqual(await broken.spinQuality({ idempotencyKey: "k" }), { ok: false, reason: "failed", status: 500 });
  const offline = await signedInStore(async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await offline.spinQuality({ idempotencyKey: "k" }), { ok: false, reason: "unreachable", status: null });
});

test("spin: a 401 refreshes once and retries with the same key", async () => {
  const spins = [];
  const store = await signedInStore(async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/device/refresh")) {
      return Response.json({ access_token: "access-2", refresh_token: "refresh-2", gateway_url: GATEWAY });
    }
    const authorization = new Headers(init.headers).get("authorization");
    spins.push({ authorization, key: JSON.parse(init.body).idempotency_key });
    return authorization === "Bearer access-1" ? new Response(null, { status: 401 }) : Response.json(SPIN);
  });
  const outcome = await store.spinQuality({ idempotencyKey: "same-key" });
  assert.equal(outcome.ok, true);
  assert.deepEqual(spins, [
    { authorization: "Bearer access-1", key: "same-key" },
    { authorization: "Bearer access-2", key: "same-key" },
  ]);
});

test("spin while signed out never calls the server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-quality-"));
  let calls = 0;
  const store = createDesktopOmniRushAccountStore({
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => testStorage(),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { OMNIRUSH_DEV_MODE: "1" },
    execFileImpl: async (file) => { throw new Error(`unexpected ${file}`); },
    fetchImpl: async () => { calls += 1; return Response.json({}); },
  });
  assert.deepEqual(await store.spinQuality({ idempotencyKey: "k" }), { ok: false, reason: "signed_out", status: null });
  assert.equal(calls, 0);
});

test("quality details: segments, expected tokens and the sessions' reasons", async () => {
  const store = await signedInStore(async (url) => {
    assert.equal(new URL(url).pathname, "/omnirush/me/quality");
    return Response.json({
      quality: QUALITY,
      sessions: [{ session_id: "ses_1", at: "2026-10-04T10:00:00Z", verdict: "review", why: "Edits outside the project.", fails: ["outside_path"], workspace: "my-app", spins: 0, counted: true }],
      segments: SEGMENTS,
      expected_tokens: 1037500,
    });
  });
  const details = await store.qualityDetails();
  assert.equal(details.segments.length, 6);
  assert.equal(details.expectedTokens, 1037500);
  assert.deepEqual(details.sessions[0].fails, ["outside_path"]);
  const off = await signedInStore(async () => Response.json({ quality: null, sessions: [], segments: [] }));
  assert.equal(await off.qualityDetails(), null);
});
