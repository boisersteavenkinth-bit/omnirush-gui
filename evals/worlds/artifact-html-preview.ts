import { browserScript, clickAt } from "@omnirush/cdp";
import type { Point } from "@omnirush/cdp";
import type { Seed } from "@omnirush/env";
import { artifactCodeBrowserWorld } from "./first-run.ts";

export const previewCanaryKey = "omnirush.eval.html-preview-canary";
export const previewWitnessKey = "omnirush.eval.html-preview-witness";
export const previewFileName = "omnirush-html-preview-proof.html";

// Only synthetic state is accessed. The desktop call reads runtime information;
// its return value is discarded, so no credentials enter the witness or evidence.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>HTML preview proof</title>
<style>body { font: 18px sans-serif; padding: 24px; } canvas { border: 1px solid #ccc; }</style>
</head><body><h1>Preview chart</h1><canvas width="320" height="160"></canvas>
<script>
(async () => {
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("2d");
  context.fillStyle = "rgb(0, 120, 255)";
  context.fillRect(20, 80, 60, 80);
  context.fillRect(120, 40, 60, 120);
  let parentDomReadable = false;
  let parentStorageReadable = false;
  let parentStorageWritable = false;
  let parentBridgeReachable = false;
  let parentDesktopCallSucceeded = false;
  try { parentDomReadable = parent.document.body.dataset.htmlPreviewCanary === "dummy-parent-value"; } catch {}
  try { parentStorageReadable = parent.localStorage.getItem("${previewCanaryKey}") === "dummy-parent-value"; } catch {}
  try {
    parent.localStorage.setItem("${previewCanaryKey}", "preview-modified");
    parentStorageWritable = parent.localStorage.getItem("${previewCanaryKey}") === "preview-modified";
  } catch {}
  try {
    parentBridgeReachable = typeof parent.__OMNIRUSH_ELECTRON__?.invokeDesktop === "function";
    if (parentBridgeReachable) {
      await parent.__OMNIRUSH_ELECTRON__.invokeDesktop("omnirushServerInfo");
      parentDesktopCallSucceeded = true;
    }
  } catch {}
  // A second chart update demonstrates that scripts remain enabled.
  setTimeout(() => {
    context.fillStyle = "rgb(255, 120, 0)";
    context.fillRect(220, 20, 60, 140);
    const pixel = context.getImageData(240, 40, 1, 1).data;
    requestAnimationFrame(() => parent.postMessage({
      type: "omnirush-html-preview-proof",
      headingRendered: document.querySelector("h1").getBoundingClientRect().height > 0,
      chartUpdated: pixel[0] === 255 && pixel[1] === 120 && pixel[2] === 0 && pixel[3] === 255,
      parentDomReadable, parentStorageReadable, parentStorageWritable,
      parentBridgeReachable, parentDesktopCallSucceeded,
    }, "*"));
  }, 100);
})();
</script></body></html>`;

export async function artifactHtmlPreviewWorld(seed: Seed) {
  const base = await artifactCodeBrowserWorld(seed);
  const wrote = await seed.evalIn(base.app, browserScript(async (workspaceId, content, fileName, canaryKey, witnessKey) => {
    const port = localStorage.getItem("omnirush.server.port");
    const token = localStorage.getItem("omnirush.server.token");
    if (!port || !token) return false;
    localStorage.setItem(canaryKey, "dummy-parent-value");
    document.body.dataset.htmlPreviewCanary = "dummy-parent-value";
    localStorage.removeItem(witnessKey);
    addEventListener("message", (event: MessageEvent<unknown>) => {
      const frame = document.querySelector(`iframe[title="${fileName}"]`);
      if (!(frame instanceof HTMLIFrameElement) || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null
        || Reflect.get(data, "type") !== "omnirush-html-preview-proof") return;
      const fields = ["headingRendered", "chartUpdated", "parentDomReadable", "parentStorageReadable",
        "parentStorageWritable", "parentBridgeReachable", "parentDesktopCallSucceeded"];
      if (!fields.every((key) => typeof Reflect.get(data, key) === "boolean")) return;
      localStorage.setItem(witnessKey, JSON.stringify({
        origin: event.origin,
        ...Object.fromEntries(fields.map((key) => [key, Reflect.get(data, key)])),
      }));
    });
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileName, content, baseUpdatedAt: null }),
    });
    return response.ok;
  }, [base.workspace.workspaceId, html, previewFileName, previewCanaryKey, previewWitnessKey]), { awaitPromise: true });
  if (wrote !== true) throw new Error("Could not seed the synthetic HTML preview.");
  return {
    ...base,
    // The workspace tree renders inside a shadow root, outside probe.dom.
    async htmlFile() {
      return seed.evalIn(base.app, browserScript((fileName) => {
        const roots = [...document.querySelectorAll("*")].flatMap((element) => element.shadowRoot ? [element.shadowRoot] : []);
        const item = roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>("[data-item-path]")])
          .find((element) => element.dataset.itemPath === fileName);
        if (!item || item.getBoundingClientRect().height === 0) return null;
        const root = item.getRootNode();
        if (!(root instanceof ShadowRoot)) return null;
        const rect = item.getBoundingClientRect();
        const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const hit = root.elementFromPoint(center.x, center.y);
        return { path: item.dataset.itemPath, center, hitTestOk: document.elementFromPoint(center.x, center.y) === root.host
          && Boolean(hit && (hit === item || item.contains(hit))) };
      }, [previewFileName]));
    },
    // Trusted mouse input for the shadow tree; this does not call DOM click().
    async clickHtmlFile(point: Point) {
      await clickAt(base.app, point);
    },
  };
}
