# ExD Accelerator — MCP Server

[![ci](https://github.com/Vikas-O7/exd-accelerator-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Vikas-O7/exd-accelerator-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](.nvmrc)

AI-native Experience Decisioning lifecycle automation for Adobe Journey Optimizer.
End-to-end ExD setup from a single chat conversation: CSV → schema fields → offers →
collections → eligibility rules → ranking → selection strategy → placements.

**21 MCP tools** wrapping AEP Schema Registry and Decisioning APIs. Every write
operation previews what it will do and requires explicit `confirmed: true` before
executing.

**Live endpoint:** `https://exd-mcp-server-without-auth.vercel.app/api/mcp`
**Health:** `https://exd-mcp-server-without-auth.vercel.app/api/health`

---

## What's new in 2.0

| Was in 1.x | Now in 2.0 |
|---|---|
| Manual ACCESS_TOKEN paste, expires every 24h | Auto-mints via `client_credentials`, cached per client_id |
| Express + SSE local server, ngrok tunnel for sharing | Streamable HTTP serverless route — deploy to Vercel in one click |
| Single hardcoded sandbox in `.env` | Per-request config via HTTP headers — every coworker uses their own sandbox |
| README claimed 13 tools, code had 21 | 21 tools, documented |
| Bulk offers defaulted to `2024-06-10` (past date) | Defaults to today + 1 year |
| `lookup_decisioning_schema` showed `0 fieldgroups` on healthy schemas | Reads from `meta:extends` too — accurate counts |
| `.gitignore` had `".env"` (quoted) — would not actually ignore | Plain `.env`, plus `.vercel/`, log files, etc. |

---

## Two ways to run this

### A. Local stdio (Claude Desktop)

```bash
npm install
cp .env.example .env       # fill in CLIENT_ID, CLIENT_SECRET, sandbox, schema, catalog
npm start                  # runs src/stdio.js
```

Then point Claude Desktop at it (`%APPDATA%\Claude\claude_desktop_config.json` on
Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS):

```json
{
  "mcpServers": {
    "exd-accelerator": {
      "command": "node",
      "args": ["/absolute/path/to/exd-mcp-server/src/stdio.js"],
      "env": {
        "CLIENT_ID":                 "…",
        "CLIENT_SECRET":             "…",
        "ORG_ID":                    "…@AdobeOrg",
        "SANDBOX_NAME":              "…",
        "TENANT_ID":                 "…",
        "DECISIONING_SCHEMA_URI":    "https://ns.adobe.com/…/schemas/…",
        "DECISIONING_SCHEMA_ALT_ID": "_….schemas.…",
        "ITEM_CATALOG_ID":           "xcore:decision-catalog:…"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see the 🔧 tool icon — ExD Accelerator is live.

### B. Vercel deployment (for sharing with Adobe coworkers)

1. Push this repo to GitHub.
2. Import it in [vercel.com/new](https://vercel.com/new). Framework preset: **Other**.
3. Deploy — Vercel auto-detects `api/mcp.js` as the serverless route.
4. **Do not** add Adobe credentials to Vercel environment variables. Each coworker
   supplies their own credentials via HTTP headers when they connect.

#### Adobe coworker setup

Once deployed at `https://your-app.vercel.app`, each coworker adds this in their
MCP client config (Claude Desktop, Adobe AO Chat, Claude.ai, etc.):

| Setting | Value |
|---|---|
| Server URL | `https://your-app.vercel.app/api/mcp` |
| Transport | Streamable HTTP |
| Auth | None at the transport level — credentials go in headers |

Custom headers (one-time, in the MCP client config — NOT in chat messages):

```
x-adobe-client-id:      <Adobe Dev Console: Client ID>
x-adobe-client-secret:  <Adobe Dev Console: Client Secret>
x-adobe-org-id:         <IMS Org ID>@AdobeOrg
x-adobe-sandbox:        <sandbox name>
x-adobe-tenant-id:      <tenant id, e.g. acssandboxgdcthree>
x-adobe-schema-uri:     https://ns.adobe.com/<tenant>/schemas/<id>
x-adobe-schema-alt-id:  _<tenant>.schemas.<id>
x-adobe-catalog-id:     xcore:decision-catalog:<id>
```

The server uses `client_credentials` to mint a token automatically, caches it per
client_id, and refreshes on expiry. The marketer never sees the token.

---

## Is Vercel a good fit for a production MCP endpoint?

**Yes, for this workload.** Each MCP tool call is a single short HTTP roundtrip
to Adobe Platform APIs — no long-running state, no streaming required, no
WebSocket. Vercel's serverless model maps cleanly:

| Concern | Verdict |
|---|---|
| Stateless requests | ✅ Each MCP call is independent. No session state. |
| Cold-start latency | ⚠️ ~300–500ms on first call after idle. Subsequent calls reuse the warm container. |
| 60s function timeout (Pro tier) | ⚠️ `bulk_create_offers` with >50 rows may exceed this. Chunk large batches. |
| 10s timeout (Hobby tier) | ⚠️ `get_setup_summary` is fine; large bulk is not. Upgrade to Pro for production use. |
| Auto-scaling | ✅ Each coworker's request gets its own invocation. |
| HTTPS, custom domain, env-per-deploy | ✅ Built in. |
| SSE / long-polling | ❌ Not used here — we run **Streamable HTTP with `enableJsonResponse: true`**, which is single-request/response and fits serverless perfectly. |

**When Vercel isn't right:** if you need server-initiated notifications, very
large bulk operations (hundreds of writes), or stateful sessions across many
calls, deploy to a long-lived host (Railway, Render, Fly, ECS) and run the same
codebase. The transport layer is the only difference.

---

## All 21 tools

### Read-only (no confirmation needed)

| # | Tool | What it does |
|---|---|---|
| 1 | `parse_csv_and_suggest` | Parses CSV, infers XDM types per column, suggests eligibility rules and ranking formulas. Always call first. No API calls. |
| 9 | `get_offer_item` | Fetches a single offer item by DPS ID |
| 10 | `list_offer_items` | Lists all offers in catalog with pagination |
| 16 | `get_setup_summary` | Full inventory: offers, collections, rules, formulas, strategies, placements |
| 17 | `lookup_decisioning_schema` | Full resolved schema with OOB + tenant fields; accepts `include_deprecated: true` |
| 18 | `list_schema_fieldgroups` | Lists all tenant fieldgroups for the offer item class |
| 19 | `get_fieldgroup` | Full field definitions inside a specific fieldgroup |
| 20 | `get_schema_audit_log` | Chronological change history for the decisioning schema |
| 21 | `list_schema_descriptors` | Identity, deprecation, display name, relationship descriptors |

### Write (require `confirmed: true`)

| # | Tool | What it does |
|---|---|---|
| 2 | `create_offer_metadata_fieldgroup` | Creates XDM fieldgroup from CSV columns, attaches to decisioning schema. Checks for duplicates first. |
| 3 | `bulk_create_offers` | Creates offer items from CSV rows. Supports `dry_run: true` for payload preview |
| 4 | `create_collection` | Creates offer collection with filter constraint |
| 5 | `create_eligibility_rule` | Creates PQL eligibility rule |
| 6 | `create_ranking_formula` | Creates ranking formula (static, custom field, recency-hybrid, custom PQL) |
| 7 | `create_selection_strategy` | Wires collection + rule + formula into a selection strategy |
| 8 | `create_placement` | Creates channel placement via `/exd-placements` endpoint |
| 11 | `update_offer_item` | JSON Patch update on any offer field |
| 12 | `add_schema_field` | Adds a single field to an existing tenant fieldgroup |
| 13 | `deprecate_schema_field` | Sets `meta:status: deprecated` on a custom tenant field |
| 14 | `deprecate_oob_field` | Creates `xdm:descriptorDeprecated` for OOB Adobe-managed fields |
| 15 | `detach_fieldgroup` | Removes fieldgroup from schema `allOf` and `meta:extends` |

### Confirmation pattern

Every write tool shows a preview and blocks with:

```
⚠️  CONFIRMATION REQUIRED — no changes made yet
[preview of what will happen]
✅ To proceed, call this tool again with confirmed: true
```

Call the same tool again with `confirmed: true` to execute.

---

## Recommended workflow from a fresh CSV

```
1.  parse_csv_and_suggest            → analyse CSV, no writes
2.  list_schema_fieldgroups          → check if fieldgroup already exists
3.  create_offer_metadata_fieldgroup → push schema fields (confirmed: true)
4.  lookup_decisioning_schema        → verify fields attached
5.  bulk_create_offers (dry_run)     → preview offer payloads
6.  bulk_create_offers (confirmed)   → create offers
7.  list_offer_items                 → verify
8.  create_collection                → group offers (confirmed: true)
9.  create_eligibility_rule          → targeting (confirmed: true)
10. create_ranking_formula           → ranking logic (confirmed: true)
11. create_selection_strategy        → wire it all together (confirmed: true)
12. create_placement                 → define channel (confirmed: true)
13. get_setup_summary                → verify full setup
```

---

## Sample CSV for testing

```csv
name,description,category,brand,discount_percent,price,region,priority,start_date,end_date
Summer Glow Kit,Complete summer skincare set,Skincare,GlowCo,20,49.99,US,1,2024-06-01,2024-08-31
SPF Starter Bundle,SPF 30 and 50 combo,Skincare,GlowCo,15,29.99,US,2,2024-06-01,2024-09-30
Loyalty 20% Off,Exclusive 20% for gold members,Discount,GlowCo,20,0,Global,1,2024-01-01,2024-12-31
```

Column mapping:
- `name` → `itemName` (OOB), `description` → `itemDescription`, `priority` → `itemPriority`, `start_date`/`end_date` → `itemCalendarConstraints`
- everything else → `_<tenant>.<column>` (custom fieldgroup)

---

## File layout

```
exd-mcp-server-without-auth/
├── src/
│   ├── server.js         ← buildMcpServer(config) + 21 tool definitions
│   ├── stdio.js          ← stdio entry (npm start) — for Claude Desktop
│   └── http-local.js     ← local HTTP server for testing the Vercel route
├── api/
│   └── mcp.js            ← Vercel serverless route (Streamable HTTP)
├── scripts/
│   └── smoke.js          ← smoke test for stdio + HTTP transports
├── vercel.json
├── package.json
├── .env.example
└── .gitignore
```

---

## Smoke testing

```bash
npm install
cp .env.example .env       # fill in
npm run smoke              # runs stdio + HTTP transport tests, calls real Adobe APIs
```

Expected output ends with `All smoke checks passed.`

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing credentials` | CLIENT_ID/CLIENT_SECRET not set | Add to `.env` (local) or to your MCP client's header config (deployed) |
| `IMS token mint failed (401)` | Credentials invalid or revoked | Regenerate the OAuth Server-to-Server credential in Adobe Developer Console |
| `401 Oauth token is not valid` from Adobe | Credential lacks AEP access | The OAuth credential's product profile needs `Adobe Experience Platform` access for the target sandbox |
| `403 Forbidden` | Wrong org/sandbox | Check `ORG_ID` and `SANDBOX_NAME` |
| List offers returns 0 | Wrong `ITEM_CATALOG_ID` for the sandbox | Each sandbox has its own catalog ID |
| Tool call exceeds 10s on Vercel Hobby | Bulk operation too large | Upgrade to Pro (60s) or chunk the CSV |
| `lookup_decisioning_schema` shows 0 fieldgroups | Resolved by 2.0 — file an issue if you still see this | — |

---

## What this MCP does NOT do (future scope)

- **Decisioning policy / campaign creation** — creates components but not the final AJO policy that ties strategy + placement.
- **Delete operations** — AEP recommends archive over delete.
- **Audience creation** — eligibility rules reference profile attributes but don't create AEP segments.
- **Cross-channel coherence scoring** — would require AEP Query Service integration.
