/**
 * Quality rewards: the `quality` block on /device/me, the wheel's
 * segments (GET /me/quality) and a spin (POST /me/quality/spin).
 *
 * `quality: null` means the feature is switched off: the app shows nothing.
 * The server picks every spin's outcome; the app only animates the wheel to
 * `segment_index`.
 */

export const QUALITY_TIERS = /** @type {const} */ (["new", "standard", "gold", "coaching", "limited"]);
export const SPIN_REFUSALS = /** @type {const} */ (["no_spins", "wheel_resting", "quality_rewards_off"]);

/**
 * @typedef {{ id: string, kind: string | null, title: string, body: string }} QualityNotice
 * @typedef {{
 *   tier: typeof QUALITY_TIERS[number],
 *   score: number,
 *   tokensMultiplier: number,
 *   spinsAvailable: number,
 *   reproSpinsAvailable: number,
 *   spinsExpireAt: string | null,
 *   nextTierHint: string | null,
 *   tips: string[],
 *   notice: QualityNotice | null,
 *   mode: "shadow" | "enforce",
 *   resting: boolean,
 *   preview: boolean,
 *   notices: QualityNotice[],
 *   streakDays: number,
 *   streakMultiplier: number,
 *   streakNext: { days: number, bonusSpins: number } | null,
 *   nextSpinHint: { progress: number, text: string, sessionId: string | null } | null,
 *   biggestWinToday: { tokens: number, at: string | null } | null,
 *   nudge: { id: string, text: string } | null,
 * }} AccountQuality
 * @typedef {{ tokens: number, weight: number }} WheelSegment
 * @typedef {{
 *   tokens: number,
 *   prizeTokens: number,
 *   segmentIndex: number,
 *   segments: WheelSegment[],
 *   preview: boolean,
 *   capped: boolean,
 *   reproducible: boolean,
 *   alreadySpun: boolean,
 *   spunAt: string | null,
 *   spinsAvailable: number,
 *   potBalance: number | null,
 *   celebrate: "none" | "big" | "jackpot",
 *   nearMiss: boolean,
 *   jackpotTokens: number | null,
 *   streakDays: number | null,
 * }} QualitySpin
 * @typedef {{ ok: true, spin: QualitySpin }
 *   | { ok: false, reason: typeof SPIN_REFUSALS[number] | "signed_out" | "unreachable" | "failed", status: number | null }} QualitySpinOutcome
 */

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function isoTime(value) {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

/** @returns {QualityNotice | null} */
function parseNotice(value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id);
  const title = text(value.title);
  if (!id || !title) return null;
  return { id, kind: text(value.kind), title, body: text(value.body) ?? "" };
}

function fraction(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

function parseStreakNext(value) {
  if (!value || typeof value !== "object") return null;
  const days = count(value.days);
  return days ? { days, bonusSpins: count(value.bonus_spins) } : null;
}

function parseNextSpinHint(value) {
  if (!value || typeof value !== "object") return null;
  const hint = text(value.text);
  return hint ? { progress: fraction(value.progress), text: hint, sessionId: text(value.session_id) } : null;
}

function parseBiggestWin(value) {
  if (!value || typeof value !== "object") return null;
  const tokens = count(value.tokens);
  return tokens ? { tokens, at: isoTime(value.at) } : null;
}

function parseNudge(value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id);
  const message = text(value.text);
  return id && message ? { id, text: message } : null;
}

/**
 * The `quality` block of a /device/me (or /me) answer; null when the
 * feature is off, the block is missing or it names no known tier.
 * @returns {AccountQuality | null}
 */
export function parseAccountQuality(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tier = text(value.tier)?.toLowerCase();
  if (!tier || !QUALITY_TIERS.includes(/** @type {any} */ (tier))) return null;
  const score = Number(value.score);
  const multiplier = Number(value.tokens_multiplier);
  const spinsAvailable = count(value.spins_available);
  const notices = Array.isArray(value.notices) ? value.notices.map(parseNotice).filter((notice) => notice !== null).slice(0, 5) : [];
  return {
    tier: /** @type {AccountQuality["tier"]} */ (tier),
    score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
    tokensMultiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
    spinsAvailable,
    reproSpinsAvailable: Math.min(spinsAvailable, count(value.repro_spins_available)),
    spinsExpireAt: isoTime(value.spins_expire_at),
    nextTierHint: text(value.next_tier_hint),
    tips: Array.isArray(value.tips) ? value.tips.map(text).filter((tip) => tip !== null).slice(0, 8) : [],
    notice: notices[0] ?? parseNotice(value.notice),
    notices: notices.length ? notices : [parseNotice(value.notice)].filter((notice) => notice !== null),
    mode: value.mode === "enforce" ? "enforce" : "shadow",
    resting: value.resting === true,
    preview: value.preview === true,
    streakDays: count(value.streak_days),
    streakMultiplier: count(value.streak_multiplier),
    streakNext: parseStreakNext(value.streak_next),
    nextSpinHint: parseNextSpinHint(value.next_spin_hint),
    biggestWinToday: parseBiggestWin(value.biggest_win_today),
    nudge: parseNudge(value.nudge),
  };
}

/** @returns {WheelSegment[]} */
export function parseWheelSegments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((segment) => segment && typeof segment === "object")
    .map((segment) => ({ tokens: count(segment.tokens), weight: Math.max(0, Number(segment.weight) || 0) }));
}

/**
 * A 200 from POST /me/quality/spin; null when it does not name a segment
 * the wheel can land on.
 * @returns {QualitySpin | null}
 */
export function parseSpinResult(value) {
  if (!value || typeof value !== "object") return null;
  const segments = parseWheelSegments(value.segments);
  const segmentIndex = Number(value.segment_index);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= segments.length) return null;
  const pot = Number(value.pot_balance);
  return {
    tokens: count(value.tokens),
    prizeTokens: count(value.prize_tokens) || segments[segmentIndex].tokens,
    segmentIndex,
    segments,
    preview: value.preview === true,
    capped: value.capped === true,
    reproducible: value.reproducible === true,
    alreadySpun: value.already_spun === true,
    spunAt: isoTime(value.spun_at),
    spinsAvailable: count(value.spins_available),
    potBalance: value.pot_balance === null || value.pot_balance === undefined || !Number.isFinite(pot) ? null : Math.max(0, pot),
    celebrate: value.celebrate === "big" || value.celebrate === "jackpot" ? value.celebrate : "none",
    nearMiss: value.near_miss === true,
    jackpotTokens: count(value.jackpot_tokens) || null,
    streakDays: value.streak_days === undefined || value.streak_days === null ? null : count(value.streak_days),
  };
}

/** The `sessions` of GET /me/quality, for the coaching card's "see why". */
export function parseQualitySessions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((session) => session && typeof session === "object" && text(session.session_id))
    .slice(0, 50)
    .map((session) => ({
      sessionId: text(session.session_id),
      at: isoTime(session.at),
      verdict: text(session.verdict),
      why: text(session.why),
      fails: Array.isArray(session.fails) ? session.fails.map(text).filter((fail) => fail !== null) : [],
      workspace: text(session.workspace),
      spins: count(session.spins),
      counted: session.counted === true,
    }));
}

/** `{"detail": "wheel_resting"}` (or `{"detail": {"code": ...}}`) from a 409. */
export function spinRefusal(payload) {
  const detail = payload && typeof payload === "object" ? payload.detail : null;
  const code = typeof detail === "string" ? detail : detail && typeof detail === "object" ? detail.code : null;
  return SPIN_REFUSALS.includes(code) ? code : null;
}

/** A caller's key, or a fresh one: at most 64 characters, as the server requires. */
export function spinIdempotencyKey(value) {
  const key = text(value);
  return key && key.length <= 64 && /^[0-9A-Za-z._:-]+$/.test(key) ? key : globalThis.crypto.randomUUID();
}
