// Disposable native app used as an OS-level witness, never a real user's app.
import { app, BrowserWindow, screen, nativeImage } from "electron";
import { createInterface } from "node:readline";
let windows = [];
app.setPath("userData", process.argv.at(-1));
const ready = app.whenReady().then(async () => {
  for (const [index, title] of ["Workspace window", "Other window"].entries()) {
    const window = new BrowserWindow({ width: 620, height: 450, x: 50 + index * 700, y: 120, title, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const html = '<title>' + title + '</title><style>body{margin:0;background:white;color:black;font:16px sans-serif}button{position:absolute;left:70px;top:70px;width:180px;height:55px}input{position:absolute;left:70px;top:160px;width:300px;height:40px;caret-color:transparent}#count{position:absolute;left:70px;top:230px}</style><button id="increment">Increment</button><input id="draft" aria-label="Fixture draft" value="Initial draft"><p id="count">0</p><script>window.counter=0;document.getElementById("increment").onclick=()=>{document.getElementById("count").textContent=String(++window.counter)}</script>';
    await window.loadURL("data:text/html," + encodeURIComponent(html)); windows.push(window);
  }
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  try {
    await ready; let result;
    if (request.method === "state") result = await Promise.all(windows.map((w) => w.webContents.executeJavaScript('({ count: window.counter, draft: document.getElementById("draft").value })')));
    else if (request.method === "bounds") result = windows.map((w) => ({ bounds: w.getBounds(), contentBounds: w.getContentBounds(), scale: screen.getDisplayMatching(w.getBounds()).scaleFactor }));
    else if (request.method === "focus_other") { windows[1].focus(); result = {}; }
    else if (request.method === "cover") { windows[1].setBounds(windows[0].getBounds()); windows[1].setAlwaysOnTop(true); await windows[1].webContents.executeJavaScript('document.body.style.background="#ff00ff"'); windows[1].focus(); result = {}; }
    else if (request.method === "image_pixel") { const image = nativeImage.createFromBuffer(Buffer.from(request.params.data, "base64")); const size = image.getSize(), pixels = image.toBitmap(); const offset = ((size.height - 50) * size.width + 20) * 4; result = { width: size.width, height: size.height, rgb: [pixels[offset + 2], pixels[offset + 1], pixels[offset]] }; }
    else if (request.method === "change") { await windows[0].webContents.executeJavaScript('document.getElementById("draft").value="Changed by person"; document.body.style.background="#eeeeee"; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); result = {}; }
    else if (request.method === "minimize") { windows[0].minimize(); result = {}; }
    else if (request.method === "restore") { windows[0].restore(); result = {}; }
    else if (request.method === "close") { app.quit(); return; }
    else throw new Error("Unknown fixture request.");
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ id: request.id, error: { message: error.message } }) + "\n"); }
});
process.stdin.on("end", () => app.quit());
