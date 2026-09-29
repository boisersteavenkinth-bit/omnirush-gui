// A minimal Electron host for the public desktop IPC boundary. It exercises the
// product integration and native preview without accounts or inference services.
import { app, BrowserWindow, desktopCapturer } from "electron";
import { createInterface } from "node:readline";
import { checkComputerUsePermissions, getComputerUseMcpCommand, getComputerUseMcpEnvironment, getComputerUseState, computerUseAction } from "../../../../apps/desktop/electron/computer-use.mjs";
app.setPath("userData", process.argv.at(-1));
const ready = app.whenReady();
createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  try {
    await ready; let result;
    if (request.method === "permissions") result = await checkComputerUsePermissions();
    else if (request.method === "command") result = { command: await getComputerUseMcpCommand(), environment: getComputerUseMcpEnvironment() };
    else if (request.method === "sources") result = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 620, height: 450 } })).map((source) => ({ id: source.id, name: source.name, size: source.thumbnail.getSize(), empty: source.thumbnail.isEmpty() }));
    else if (request.method === "state") result = await getComputerUseState();
    else if (request.method === "preview_action") {
      const preview = BrowserWindow.getAllWindows().find((window) => window.getTitle().includes("Computer Use"));
      if (!preview) throw new Error("Native preview unavailable.");
      if (!["pause", "hide", "stop"].includes(request.params.action)) throw new Error("Invalid preview command.");
      await preview.webContents.executeJavaScript("document.getElementById(" + JSON.stringify(request.params.action) + ").click()"); result = {};
    }
    else if (request.method === "action") { await computerUseAction(request.params); result = {}; }
    else throw new Error("Unknown host witness operation.");
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ id: request.id, error: { message: error.message } }) + "\n"); }
});
process.stdin.on("end", () => app.quit());
