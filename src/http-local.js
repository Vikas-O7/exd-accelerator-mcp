#!/usr/bin/env node
// Local HTTP test server — mimics the Vercel /api/mcp route on http://localhost:3000/mcp.
// Useful for smoke-testing the Streamable HTTP transport without deploying.

import "dotenv/config";
import http from "node:http";
import handler from "../api/mcp.js";

const PORT = process.env.PORT || 3000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => buf += c);
    req.on("end", () => {
      if (!buf) return resolve(undefined);
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", server: "exd-accelerator", version: "2.0.0" }));
    return;
  }
  if (req.url !== "/mcp" && req.url !== "/api/mcp") {
    res.statusCode = 404;
    res.end("Not found. Use /mcp or /api/mcp.");
    return;
  }
  try {
    if (req.method === "POST") req.body = await readBody(req);
    await handler(req, res);
  } catch (e) {
    console.error("[exd-mcp:local] handler error:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.listen(PORT, () => {
  console.error(`[exd-mcp] Local HTTP : http://localhost:${PORT}/mcp`);
  console.error(`[exd-mcp] Health     : http://localhost:${PORT}/health`);
  console.error(`[exd-mcp] Sandbox    : ${process.env.SANDBOX_NAME || "unset"}`);
});
