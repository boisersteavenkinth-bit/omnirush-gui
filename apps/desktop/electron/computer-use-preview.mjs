import { BrowserWindow, ipcMain, desktopCapturer } from "electron";
import { fileURLToPath } from "node:url";
export async function captureComputerWindow(window) {
  const limit = 1600, ratio = Math.min(1, limit / Math.max(window.bounds.width, window.bounds.height));
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: Math.round(window.bounds.width * ratio), height: Math.round(window.bounds.height * ratio) }, fetchWindowIcons: false });
  const source = sources.find((item) => Number(item.id.split(":")[1]) === window.id);
  if (!source || source.thumbnail.isEmpty()) throw Object.assign(new Error("This window could not be captured. Keep it visible; protected video and some GPU windows may not support capture."), { code: "capture_unavailable" });
  const size = source.thumbnail.getSize();
  if (size.width <= 0 || size.height <= 0 || Math.abs(size.width / size.height - window.bounds.width / window.bounds.height) > 0.04) throw Object.assign(new Error("The captured window size changed. Observe again."), { code: "window_changed" });
  return { image: source.thumbnail.toPNG(), size };
}
export function createComputerPreview() {
  let host, panel, current;
  const channel = "omnirush-computer-use-preview-action";
  const action = (_event, value) => {
    if (!panel || _event.sender !== panel.webContents || _event.senderFrame !== panel.webContents.mainFrame || !["stop", "hide", "pause"].includes(value) || !current) return;
    if (value === "pause") host.pause(current.connectionId);
    else void host.action({ connectionId: current.connectionId, id: current.id, action: value }).catch(() => {});
  };
  ipcMain.on(channel, action);
  const show = () => {
    if (panel && !panel.isDestroyed()) { panel.showInactive(); return; }
    panel = new BrowserWindow({ width: 330, height: 300, title: "OmniRush.ai · Computer Use", show: false, alwaysOnTop: true, resizable: true, minimizable: false, webPreferences: { preload: fileURLToPath(new URL("./computer-use-preview-preload.cjs", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.on("close", (event) => { if (!current) return; event.preventDefault(); void host.action({ connectionId: current.connectionId, id: current.id, action: "hide" }).catch(() => {}); });
    panel.webContents.once("did-finish-load", () => { if (current?.previewVisible) { panel.webContents.send("omnirush-computer-use-preview-state", current); panel.showInactive(); } });
    void panel.loadFile(fileURLToPath(new URL("./computer-use-preview.html", import.meta.url)));
  };
  return {
    bind(value) { host = value; },
    update(states) {
      current = states.find((value) => value.phase !== "approval");
      if (!current || !current.previewVisible) { panel?.hide(); return; }
      show(); panel.webContents.send("omnirush-computer-use-preview-state", current);
    },
    image(image) { panel?.webContents.send("omnirush-computer-use-preview-image", "data:image/png;base64," + image.toString("base64")); },
    close() { current = null; panel?.destroy(); panel = null; ipcMain.removeListener(channel, action); },
  };
}
