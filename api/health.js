// Lightweight liveness probe — no Adobe call, no credentials needed.
// Useful for uptime monitors and CI smoke tests.

export const config = {
  maxDuration: 10,
};

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.statusCode = 200;
  res.end(JSON.stringify({
    status:  "ok",
    server:  "exd-accelerator",
    version: "2.0.0",
    transport: "streamable-http",
    runtime: "vercel",
    time:    new Date().toISOString(),
  }));
}
