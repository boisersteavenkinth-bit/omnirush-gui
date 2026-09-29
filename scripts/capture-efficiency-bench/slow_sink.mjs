import { createServer } from "node:http";
import { createHash } from "node:crypto";
const BYTES_PER_SECOND = 6 * 1024 * 1024;
const server = createServer((req, res) => {
  let bytes = 0, chunks = 0;
  const digest = createHash("sha256");
  const started = performance.now();
  req.on("data", chunk => {
    bytes += chunk.length; chunks += 1; digest.update(chunk);
    const wait = bytes / BYTES_PER_SECOND * 1000 - (performance.now() - started);
    if (wait > 2) {
      req.pause();
      setTimeout(() => req.resume(), wait);
    }
  });
  req.on("end", () => {
    res.writeHead(201, {"Content-Type": "application/json"});
    res.end(JSON.stringify({bytes, chunks, elapsed_ms: Math.round(performance.now() - started), sha256: digest.digest("hex")}));
  });
  req.on("error", () => res.destroy());
});
server.listen(18692, "127.0.0.1");
