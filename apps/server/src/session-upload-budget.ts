/**
 * The omnirush.ai endpoint every session upload is sent to, relative to the
 * gateway root (the gateway URL without its trailing /v1): with the hosted
 * gateway that is POST https://<host>/omnirush/collect. The path is the
 * server's API and stays "collect" whatever the desktop code calls its
 * uploader; renaming it here would break every upload.
 */
export const SESSION_UPLOAD_ENDPOINT_PATH = "collect";

/**
 * How long one session upload (POST <gateway>/collect) may take.
 *
 * Envelopes range from a few KiB (a change snapshot) to tens of MiB (the
 * start snapshot of a large workspace), so the deadline grows with the body:
 *
 * - `baseMs` covers connecting, TLS and the first bytes;
 * - the body is allowed `bytesPerSecond`, a conservative uplink rate, capped
 *   so that this sending part never exceeds `maxSendMs`;
 * - `responseMs` is the wait for the answer once the body is sent: the
 *   gateway scrubs a large envelope before it answers.
 *
 * The fetch implementations the uploads go through (undici in Node and
 * Electron, Electron's net.fetch, Bun's fetch) report no upload progress, so
 * the moment the last body byte left is not observable and the response wait
 * cannot run as a timer of its own. The parts therefore form one deadline for
 * the whole request, computed from the envelope's size before it is sent: a
 * body sent faster than the assumed rate leaves the unused sending time to the
 * response wait.
 */
export type SessionUploadBudget = {
  baseMs: number;
  bytesPerSecond: number;
  maxSendMs: number;
  responseMs: number;
};

export const SESSION_UPLOAD_BUDGET: SessionUploadBudget = {
  baseMs: 30_000,
  bytesPerSecond: 128 * 1024,
  maxSendMs: 15 * 60_000,
  responseMs: 120_000,
};

/** The whole-request deadline, in milliseconds, for a session upload of `bytes`. */
export function sessionUploadTimeoutMs(bytes: number, budget: SessionUploadBudget = SESSION_UPLOAD_BUDGET): number {
  const sendMs = budget.baseMs + Math.ceil((Math.max(0, bytes) * 1_000) / budget.bytesPerSecond);
  return Math.min(budget.maxSendMs, sendMs) + budget.responseMs;
}
