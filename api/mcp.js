// Vercel serverless route — POST /api/mcp speaks MCP Streamable HTTP.
//
// Each request is stateless: a fresh McpServer is built per call, configured from
// the caller's HTTP headers (so each Adobe coworker can supply their own
// CLIENT_ID / CLIENT_SECRET / sandbox / schema IDs).
//
// To connect from an MCP client, set the server URL to:
//    https://<your-vercel-app>.vercel.app/api/mcp
// and add these headers (in the client's MCP config, NOT in the chat):
//    x-adobe-client-id:      <Adobe Developer Console: Client ID>
//    x-adobe-client-secret:  <Adobe Developer Console: Client Secret>
//    x-adobe-org-id:         <your IMS Org ID>@AdobeOrg
//    x-adobe-sandbox:        <sandbox name>
//    x-adobe-tenant-id:      <your tenant id, e.g. acssandboxgdcthree>
//    x-adobe-schema-uri:     <full decisioning schema $id URI>
//    x-adobe-schema-alt-id:  <decisioning schema meta:altId>
//    x-adobe-catalog-id:     xcore:decision-catalog:xxxxxxxxxxxxxxxx

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer, getConfig } from "../src/server.js";

export const config = {
  // 60s on Vercel Pro, 10s on Hobby. Bulk operations with many offers may exceed this.
  maxDuration: 60,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, " +
    "x-adobe-client-id, x-adobe-client-secret, x-adobe-org-id, x-adobe-sandbox, " +
    "x-adobe-tenant-id, x-adobe-schema-uri, x-adobe-schema-alt-id, " +
    "x-adobe-catalog-id, x-adobe-offer-class, x-adobe-access-token"
  );
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  try {
    const userConfig = getConfig(req.headers || {});
    const server     = buildMcpServer(userConfig);
    const transport  = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // stateless — fits serverless
      enableJsonResponse: true,        // JSON, not SSE — works on Vercel without keep-alive
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[exd-mcp:vercel] handler failed:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: e.message || String(e) } }));
    }
  }
}
