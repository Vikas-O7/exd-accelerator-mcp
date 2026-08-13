// Human-readable disclaimer for anyone landing on the endpoint.
// Serves both HTML (for browsers) and JSON (for programmatic clients),
// content-negotiated on the Accept header.

export const config = {
  maxDuration: 10,
};

const DISCLAIMER = {
  title: "ExD Accelerator — MCP Server",
  tagline: "Community-maintained side project. Not an Adobe product.",
  maintainers: [
    { name: "Khushi Nayal", github: "https://github.com/khushi-nayal" },
    { name: "Vikas Ohlan",  github: "https://github.com/Vikas-O7" },
  ],
  source:      "https://github.com/Vikas-O7/exd-accelerator-mcp",
  issues:      "https://github.com/Vikas-O7/exd-accelerator-mcp/issues",
  license:     "Apache-2.0",
  affiliation: "None. This project is independent and is NOT affiliated with, endorsed by, produced by, or supported by Adobe Inc. Adobe, Adobe Experience Platform, Adobe Journey Optimizer, and Adobe Experience Decisioning are trademarks of Adobe Inc. — named here only to describe which public APIs this software calls on behalf of the user.",
  intendedUse: "Development sandbox exploration only. NOT for production sandboxes.",
  warranty:    "None. Provided AS-IS under the Apache 2.0 license, without warranty of any kind, express or implied.",
  sla:         "None. No uptime commitments. Endpoint runs on Vercel's free Hobby tier and may pause or go offline at any time.",
  support:     "Best-effort via GitHub Issues only. No email, no chat, no on-call.",
  credentialHandling: {
    location: "Adobe credentials are sent by the user in HTTP request headers on each call.",
    storage:  "Held in memory only for the lifetime of a single request. Never written to disk. Never persisted.",
    logging:  "The server does not log credential values. Vercel's platform observability may capture request metadata under Vercel's standard privacy policy.",
    thirdParties: "None. The server calls only Adobe's public IMS, Schema Registry, Decisioning, and Unified Profile Service APIs. No other outbound network calls are made.",
  },
  security:    "Users bring their own OAuth Server-to-Server credentials for their own AEP sandbox. Server compromise scenarios are limited to in-transit credentials — no stored secrets to exfiltrate.",
};

function renderHtml(d) {
  const list = (arr, fn) => arr.map(fn).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${d.title} — About</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.5rem; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #0f172a; color: #e2e8f0; } a { color: #93c5fd; } }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .tag { font-size: 15px; opacity: 0.7; margin-bottom: 2rem; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin: 2rem 0 0.5rem; }
  p, li { margin: 0.4rem 0; }
  ul { padding-left: 1.2rem; }
  code { background: rgba(127,127,127,0.15); padding: 1px 5px; border-radius: 3px; font-size: 13px; }
  .warn { background: rgba(245, 158, 11, 0.12); border-left: 3px solid #f59e0b; padding: 0.75rem 1rem; margin: 1rem 0; }
</style>
</head>
<body>
  <h1>${d.title}</h1>
  <div class="tag">${d.tagline}</div>

  <div class="warn">
    <strong>Intended use:</strong> ${d.intendedUse}<br>
    <strong>Warranty:</strong> ${d.warranty}<br>
    <strong>Uptime SLA:</strong> ${d.sla}
  </div>

  <h2>Maintainers</h2>
  <ul>${list(d.maintainers, m => `<li><a href="${m.github}">${m.name}</a></li>`)}</ul>

  <h2>Source &amp; License</h2>
  <ul>
    <li><a href="${d.source}">${d.source}</a></li>
    <li>License: <code>${d.license}</code></li>
    <li>Issues &amp; support: <a href="${d.issues}">GitHub Issues</a> (best-effort only)</li>
  </ul>

  <h2>Affiliation</h2>
  <p>${d.affiliation}</p>

  <h2>Credential handling</h2>
  <ul>
    <li><strong>Location:</strong> ${d.credentialHandling.location}</li>
    <li><strong>Storage:</strong> ${d.credentialHandling.storage}</li>
    <li><strong>Logging:</strong> ${d.credentialHandling.logging}</li>
    <li><strong>Third parties:</strong> ${d.credentialHandling.thirdParties}</li>
  </ul>

  <h2>Security posture</h2>
  <p>${d.security}</p>

  <h2>What this endpoint is</h2>
  <p>An MCP (Model Context Protocol) server exposing 47 tools for reading and writing Adobe Experience Decisioning resources via Adobe's public APIs. Intended for exploration and prototyping in development sandboxes using an MCP-capable AI client (Claude Desktop, Claude Code, or similar).</p>

  <p>Programmatic access: send <code>Accept: application/json</code> to receive this content as JSON.</p>
</body>
</html>`;
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.statusCode = 200;

  const accept = req.headers.accept || "";
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(DISCLAIMER, null, 2));
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(renderHtml(DISCLAIMER));
}
