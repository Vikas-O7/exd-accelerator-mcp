// App Builder web action — bridges Adobe I/O Runtime's params-based function
// model to the MCP Streamable HTTP transport, using the Web Standard transport
// (Request/Response) directly. Skips @hono/node-server, which needs a real
// Node IncomingMessage that OpenWhisk's params model can't provide.
//
// Deployed URL:
//   https://<namespace>.adobeioruntime.net/api/v1/web/exd-accelerator/mcp

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer, getConfig } from "../../src/server.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": [
    "Content-Type",
    "Accept",
    "Authorization",
    "mcp-session-id",
    "mcp-protocol-version",
    "x-adobe-client-id",
    "x-adobe-client-secret",
    "x-adobe-org-id",
    "x-adobe-sandbox",
    "x-adobe-tenant-id",
    "x-adobe-schema-uri",
    "x-adobe-schema-alt-id",
    "x-adobe-catalog-id",
    "x-adobe-offer-class",
    "x-adobe-access-token",
  ].join(", "),
  "Access-Control-Max-Age": "86400",
};

export async function main(params) {
  const headers = params.__ow_headers || {};
  const method  = (params.__ow_method || "post").toUpperCase();

  // Reconstruct the request body. I/O Runtime hands us either:
  //  - a base64 __ow_body (for non-JSON or when raw-http is on), or
  //  - the parsed JSON spread into params (raw-http: false, our config)
  let bodyText;
  if (typeof params.__ow_body === "string" && params.__ow_body.length) {
    try { bodyText = Buffer.from(params.__ow_body, "base64").toString("utf8"); }
    catch { bodyText = params.__ow_body; }
  } else {
    const stripped = Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith("__ow_")));
    bodyText = Object.keys(stripped).length ? JSON.stringify(stripped) : undefined;
  }

  // Preflight
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS };

  // Friendly GET
  if (method === "GET") {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: {
        server: "exd-accelerator",
        version: "2.0.0",
        transport: "streamable-http",
        runtime: "adobe-io-runtime",
        message: "POST JSON-RPC 2.0 here.",
      },
    };
  }

  try {
    // Build a Web Standard Request that the transport understands directly
    const url        = `https://placeholder.local/mcp`;    // host doesn't matter — transport only uses method + headers + body
    const webRequest = new Request(url, {
      method,
      headers,
      ...(bodyText ? { body: bodyText } : {}),
    });

    const server    = buildMcpServer(getConfig(headers));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless
      enableJsonResponse: true,         // JSON, not SSE
    });
    await server.connect(transport);

    const webResponse = await transport.handleRequest(webRequest);

    // Copy Web Response → App Builder response shape
    const responseHeaders = { ...CORS_HEADERS };
    for (const [k, v] of webResponse.headers) responseHeaders[k] = v;
    const responseText = await webResponse.text();
    // App Builder tries to be helpful and reserialize JSON if you return an object body,
    // which double-encodes our response. Always return the raw text.
    return {
      statusCode: webResponse.status,
      headers:    responseHeaders,
      body:       responseText,
    };
  } catch (e) {
    console.error("[exd-mcp:app-builder] handler failed:", e);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: e.message || String(e) } }),
    };
  }
}
