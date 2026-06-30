#!/usr/bin/env node
// Smoke test — exercises the MCP server via both stdio and HTTP transports.
// Reads credentials from .env in the project root. Uses CLIENT_ID + CLIENT_SECRET
// to auto-mint tokens (no ACCESS_TOKEN required).

import "dotenv/config";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✅", msg);
  else { console.log("  ❌", msg); failures++; }
}

// ───────────── stdio path ─────────────
async function runStdio() {
  console.log("\n=== STDIO TRANSPORT ===");
  const child = spawn("node", [path.join(ROOT, "src", "stdio.js")], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  child.stderr.on("data", d => process.stderr.write("[srv] " + d));

  let buf = "";
  const pending = new Map();
  let id = 0;
  child.stdout.on("data", d => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error("timeout " + method)); } }, 30000);
  });

  await wait(500);
  const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0" } });
  assert(init.result?.serverInfo?.name === "exd-accelerator", "stdio initialize returns exd-accelerator");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await send("tools/list", {});
  assert((list.result?.tools || []).length === 21, "stdio lists 21 tools (got " + (list.result?.tools?.length || 0) + ")");

  // No-API tools: should work without credentials
  const csv = `name,category,discount_percent,priority\nSummer Kit,Skincare,20,1\nLoyalty 10,Discount,10,2`;
  const parseRes = await send("tools/call", { name: "parse_csv_and_suggest", arguments: { csv_text: csv } });
  assert(parseRes.result?.content?.[0]?.text?.includes("CSV parsed"), "parse_csv_and_suggest works without credentials");

  // API tools: should fail cleanly if creds missing, succeed otherwise
  const summary = await send("tools/call", { name: "get_setup_summary", arguments: {} });
  const summaryText = summary.result?.content?.[0]?.text || "";
  if (process.env.CLIENT_ID && process.env.CLIENT_SECRET) {
    assert(summaryText.includes("ExD SETUP SUMMARY"), "get_setup_summary returns data when creds set");
  } else {
    assert(summaryText.includes("Missing required config") || summaryText.includes("Missing credentials"),
      "get_setup_summary fails cleanly when creds missing");
  }

  // bulk_create_offers dry_run should NOT need credentials
  const dryRun = await send("tools/call", { name: "bulk_create_offers", arguments: { csv_text: csv, dry_run: true } });
  const dryText = dryRun.result?.content?.[0]?.text || "";
  assert(dryText.includes("DRY RUN"), "bulk_create_offers dry_run works");
  assert(!dryText.includes("2024-06-10"), "bulk_create_offers no longer uses 2024-06-10 hardcoded date");

  // Confirmation guard
  const ruleAttempt = await send("tools/call", { name: "create_eligibility_rule", arguments: { name: "smoke", pql_expression: "true" } });
  const ruleText = ruleAttempt.result?.content?.[0]?.text || "";
  assert(ruleText.includes("CONFIRMATION REQUIRED"), "create_eligibility_rule blocks without confirmed:true");

  child.kill();
  await wait(200);
}

// ───────────── HTTP path ─────────────
async function runHttp() {
  console.log("\n=== HTTP TRANSPORT (local) ===");
  const child = spawn("node", [path.join(ROOT, "src", "http-local.js")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: false,
    env: { ...process.env, PORT: "3030" },
  });
  child.stderr.on("data", d => process.stderr.write("[srv] " + d));
  await wait(800);

  async function rpc(payload, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request({
        host: "localhost", port: 3030, path: "/mcp", method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "Accept":          "application/json, text/event-stream",
          "Content-Length":   Buffer.byteLength(data),
          ...extraHeaders,
        },
      }, res => {
        let buf = ""; res.on("data", c => buf += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode, body: buf }); }
        });
      });
      req.on("error", reject);
      req.write(data); req.end();
    });
  }

  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0" } } });
  assert(init.body?.result?.serverInfo?.name === "exd-accelerator", "http initialize returns exd-accelerator");

  // Notification of initialized (no id, no response expected — fire and forget; server expects this before tools/list)
  await new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const req = http.request({
      host: "localhost", port: 3030, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Content-Length": Buffer.byteLength(data) },
    }, res => { res.on("data", () => {}); res.on("end", resolve); });
    req.on("error", reject);
    req.write(data); req.end();
  });

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert((list.body?.result?.tools || []).length === 21, "http lists 21 tools (got " + (list.body?.result?.tools?.length || 0) + ")");

  // Call a tool with credentials passed as headers (mimics how Coworker users will connect)
  if (process.env.CLIENT_ID && process.env.CLIENT_SECRET) {
    const summary = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_setup_summary", arguments: {} } },
      {
        "x-adobe-client-id":     process.env.CLIENT_ID,
        "x-adobe-client-secret": process.env.CLIENT_SECRET,
        "x-adobe-org-id":        process.env.ORG_ID,
        "x-adobe-sandbox":       process.env.SANDBOX_NAME,
        "x-adobe-tenant-id":     process.env.TENANT_ID,
        "x-adobe-schema-uri":    process.env.DECISIONING_SCHEMA_URI,
        "x-adobe-schema-alt-id": process.env.DECISIONING_SCHEMA_ALT_ID,
        "x-adobe-catalog-id":    process.env.ITEM_CATALOG_ID,
      }
    );
    const text = summary.body?.result?.content?.[0]?.text || "";
    assert(text.includes("ExD SETUP SUMMARY"), "http get_setup_summary returns data using header-supplied credentials");
  }

  child.kill();
  await wait(200);
}

try {
  await runStdio();
  await runHttp();
} catch (e) {
  console.error("Smoke driver error:", e);
  failures++;
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
