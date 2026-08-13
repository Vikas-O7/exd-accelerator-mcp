# ExD Accelerator — MCP Server

[![ci](https://github.com/Vikas-O7/exd-accelerator-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Vikas-O7/exd-accelerator-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](.nvmrc)

> ### ⚠️ Unofficial community side project — not an Adobe product
>
> This is a **personal side project** by
> [Khushi Nayal](https://github.com/khushi-nayal) and
> [Vikas Ohlan](https://github.com/Vikas-O7), built for personal exploration
> and community sharing. It is **not affiliated with, endorsed by, produced by,
> or supported by Adobe Inc.** in any capacity, and does not represent any
> employer's views or products.
>
> The project calls Adobe Experience Platform's *public* Schema Registry and
> Decisioning APIs on behalf of a user who already holds valid credentials for
> those APIs. Adobe, Adobe Experience Platform, Adobe Journey Optimizer, and
> Adobe Experience Decisioning are trademarks of Adobe Inc.; their names appear
> here only to describe which public APIs this software calls.
>
> **Intended for development sandboxes only. Do not use against production
> sandboxes.** No warranty, no support SLA, no uptime commitments. Use at your
> own risk under the Apache 2.0 license.

---

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that
wraps Adobe Experience Platform's Schema Registry and Decisioning (DPS) APIs so
an LLM client — Claude Desktop, Claude Code, or any other MCP-capable
assistant — can help you build a complete Experience Decisioning setup from a
single chat conversation:

CSV → schema fields → offers → collections → eligibility rules → ranking →
selection strategy → placements.

**47 tools.** Every write operation previews what it will do and requires an
explicit `confirmed: true` before executing. Cursor pagination throughout,
soft deadlines on bulk operations, automatic 409/429/5xx retries, and
dependency-scan previews on every destructive delete.

---

## Try it in 30 seconds (hosted demo)

A demo endpoint is running on free Vercel infra:

- **MCP URL:** `https://exd-accelerator-mcp.vercel.app/api/mcp`
- **About / terms:** [`https://exd-accelerator-mcp.vercel.app/api/about`](https://exd-accelerator-mcp.vercel.app/api/about)
- **Health check:** [`https://exd-accelerator-mcp.vercel.app/api/health`](https://exd-accelerator-mcp.vercel.app/api/health)

Add it to your MCP client (Claude Desktop, Claude Code, etc.) with these
settings — supplying your **own Adobe credentials** as HTTP headers:

| Setting | Value |
|---|---|
| Server URL | `https://exd-accelerator-mcp.vercel.app/api/mcp` |
| Transport | Streamable HTTP |
| Auth | None at the transport level — credentials go in headers |

Headers to configure (from Adobe Developer Console for your **development
sandbox** — never a production sandbox):

```
x-adobe-client-id:      <OAuth Server-to-Server Client ID>
x-adobe-client-secret:  <OAuth Server-to-Server Client Secret>
x-adobe-org-id:         <your IMS Org ID>@AdobeOrg
x-adobe-sandbox:        <development sandbox name>
x-adobe-tenant-id:      <your tenant id>
x-adobe-schema-uri:     <full decisioning schema $id URI>
x-adobe-schema-alt-id:  <decisioning schema meta:altId>
x-adobe-catalog-id:     xcore:decision-catalog:xxxxxxxxxxxxxxxx
```

The server holds these headers in memory only for the lifetime of the request,
mints an IMS token, calls Adobe on your behalf, and discards everything when
the call completes. Nothing is written to disk. See the
[`/api/about`](https://exd-accelerator-mcp.vercel.app/api/about) page for the
full statement.

**The demo endpoint runs on Vercel's free Hobby tier with no uptime commitment
and no support SLA.** For anything more than kicking tires, fork this repo and
self-host — instructions below.

---

## What you need to try this

Before you can run anything against a live sandbox, you need Adobe access —
this project doesn't provision anything for you.

1. **An Adobe Experience Platform sandbox** with Experience Decisioning
   enabled. This is licensed capability; if you don't have it, most of the
   tools will fail with a 403.
2. **An OAuth Server-to-Server credential** created in
   [Adobe Developer Console](https://developer.adobe.com/console), attached to
   a product profile that grants Experience Platform access for your target
   sandbox. You'll need the resulting `CLIENT_ID` and `CLIENT_SECRET`.
3. **Node.js ≥ 18** (for local runs) — or a Vercel account if you want to host
   the server yourself.
4. **An MCP-compatible client** — the reference is
   [Claude Desktop](https://claude.ai/download); Claude Code and any other
   client that speaks the MCP protocol will also work.

You'll also need to know these tenant-specific values for your sandbox:

| Value | Where to find it |
|---|---|
| `ORG_ID` | Adobe Admin Console → your org's ID (ends in `@AdobeOrg`) |
| `SANDBOX_NAME` | Experience Platform → Sandboxes |
| `TENANT_ID` | Experience Platform → Schemas → look at any tenant-scoped schema (the `_` prefix) |
| `DECISIONING_SCHEMA_URI` / `DECISIONING_SCHEMA_ALT_ID` | Your Personalized Offer Items schema in Schema Registry |
| `ITEM_CATALOG_ID` | Decisioning → Catalogs |

---

## Quick start (local, stdio)

Fastest way to try it: run against your own sandbox from your laptop, no
hosting needed.

```bash
git clone https://github.com/Vikas-O7/exd-accelerator-mcp.git
cd exd-accelerator-mcp
npm install
cp .env.example .env
# open .env and fill in the 8 required values
```

Sanity-check with the smoke test (makes real API calls to your sandbox):

```bash
npm run smoke
```

You should see `All smoke checks passed.` If not, jump to [Troubleshooting](#troubleshooting).

### Wire it into Claude Desktop

Edit your Claude Desktop config
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "exd-accelerator": {
      "command": "node",
      "args": ["/absolute/path/to/exd-accelerator-mcp/src/stdio.js"],
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

Restart Claude Desktop. You'll see the 🔧 tool icon — the ExD Accelerator is
live.

---

## Hosting it yourself (HTTP)

If you want a shared endpoint your team can point their MCP clients at, deploy
the same codebase as an HTTP server on Vercel:

1. Fork or clone this repo into your own GitHub account.
2. Import it in [vercel.com/new](https://vercel.com/new). Framework preset:
   **Other**.
3. Deploy — Vercel auto-detects `api/mcp.js` as the serverless route.
4. **Do not** put credentials in Vercel's environment variables. Each user of
   the endpoint supplies their own credentials via HTTP headers on the MCP
   connection (see below).

For a truly no-cost setup, use Vercel Hobby and remove any payment method in
your account billing settings — the endpoint will pause if it exceeds free-tier
limits rather than incurring charges.

### Header-based multi-tenant credentials

The server treats HTTP headers as the source of truth for per-request
credentials, so a single hosted deployment can serve multiple users without
storing any secrets on the server side:

```
x-adobe-client-id:      <Adobe Dev Console: Client ID>
x-adobe-client-secret:  <Adobe Dev Console: Client Secret>
x-adobe-org-id:         <IMS Org ID>@AdobeOrg
x-adobe-sandbox:        <sandbox name>
x-adobe-tenant-id:      <tenant id, e.g. mytenantname>
x-adobe-schema-uri:     https://ns.adobe.com/<tenant>/schemas/<id>
x-adobe-schema-alt-id:  _<tenant>.schemas.<id>
x-adobe-catalog-id:     xcore:decision-catalog:<id>
```

The server uses `client_credentials` to mint tokens automatically, caches them
per `client_id` for the token's lifetime, invalidates on 401, and refreshes on
expiry. The end user never sees the token.

MCP client config for a hosted deployment:

| Setting | Value |
|---|---|
| Server URL | `https://your-deployment/api/mcp` |
| Transport | Streamable HTTP |
| Auth | None at the transport level — credentials go in headers |

---

## Sample data for testing

### CSV

```csv
name,description,category,brand,discount_percent,price,region,priority,start_date,end_date
Summer Glow Kit,Complete summer skincare set,Skincare,GlowCo,20,49.99,US,1,2024-06-01,2024-08-31
SPF Starter Bundle,SPF 30 and 50 combo,Skincare,GlowCo,15,29.99,US,2,2024-06-01,2024-09-30
Loyalty 20% Off,Exclusive 20% for gold members,Discount,GlowCo,20,0,Global,1,2024-01-01,2024-12-31
```

Column mapping:
- `name` → `itemName` (OOB), `description` → `itemDescription`, `priority` →
  `itemPriority`, `start_date`/`end_date` → `itemCalendarConstraints`
- everything else → `_<tenant>.<column>` (custom fieldgroup, created for you
  on first use)

### JSON

`bulk_create_offers` accepts `json_text` in place of `csv_text` — either a
bare array of offer objects, or `{"offers": [...]}`. Each object's keys act
exactly like CSV column headers (case-insensitive, punctuation-tolerant, so
`startDate`, `start_date`, and `Start Date` are all treated the same):

```json
[
  {
    "name": "Summer Glow Kit",
    "description": "Complete summer skincare set",
    "category": "Skincare",
    "brand": "GlowCo",
    "discount_percent": 20,
    "price": 49.99,
    "region": "US",
    "priority": 1,
    "start_date": "2024-06-01",
    "end_date": "2024-08-31"
  }
]
```

Provide exactly one of `csv_text` or `json_text`; passing both or neither
returns a clear error.

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
8.  list_placements                  → discover placements to wire to
9.  list_audiences                   → discover audiences to target (RT-CDP)
10. create_collection                → group offers (confirmed: true)
11. create_eligibility_rule          → targeting (confirmed: true)
12. create_ranking_formula           → ranking logic (confirmed: true)
13. create_selection_strategy        → wire it all together (confirmed: true)
14. get_setup_summary                → verify full setup
```

Or, in a real chat, just say something like:
*"I have a CSV of 25 skincare offers here. Load them into `my-sandbox`, group
by category, target visitors in the DOI Email Audience, rank by discount
descending, and wire it all to my hero-banner placement."*

---

## Tool inventory

47 tools organized by resource. Every write requires `confirmed: true`.

### Utility / setup (7)

`get_setup_summary`, `lookup_decisioning_schema`, `list_schema_descriptors`,
`list_schema_fieldgroups`, `get_fieldgroup`, `get_schema_audit_log`,
`parse_csv_and_suggest`.

### Schema mutation (5)

`add_schema_field`, `deprecate_schema_field`, `deprecate_oob_field`,
`detach_fieldgroup`, `create_offer_metadata_fieldgroup`.

### Placements (5)

`list_placements`, `get_placement`, `create_placement`, `update_placement`,
`delete_placement`.

### Offer items (8)

`list_offer_items`, `get_offer_item`, `update_offer_item`, `delete_offer_item`,
`bulk_create_offers`, `bulk_update_offers`, `bulk_delete_offers`,
`attach_offer_eligibility_rule`.

### Collections (5)

`list_collections`, `get_collection`, `create_collection`, `update_collection`,
`delete_collection`.

### Eligibility rules (5)

`list_eligibility_rules`, `get_eligibility_rule`, `create_eligibility_rule`,
`update_eligibility_rule`, `delete_eligibility_rule`.

### Ranking formulas (5)

`list_ranking_formulas`, `get_ranking_formula`, `create_ranking_formula`,
`update_ranking_formula`, `delete_ranking_formula`.

### Selection strategies (5)

`list_selection_strategies`, `get_selection_strategy`,
`create_selection_strategy`, `update_selection_strategy`,
`delete_selection_strategy`.

### RT-CDP audiences (2, read-only)

`list_audiences`, `get_audience` — audiences themselves are managed in the
RT-CDP Segmentation Service, not here. These two just let the LLM discover
them before wiring them into offer eligibility.

Every tool that identifies an existing resource — `get_*`, `update_*`,
`delete_*`, and the bulk / attach offer tools — accepts either a DPS ID **or**
an exact resource name. Ambiguous names fail with a list of all matches
rather than guessing.

### Confirmation pattern

Every write tool shows a preview and blocks with:

```
⚠️  CONFIRMATION REQUIRED — no changes made yet
[preview of what will happen]
✅ To proceed, call this tool again with confirmed: true
```

Call the same tool again with `confirmed: true` to execute. Delete tools also
scan for dependencies (e.g. selection strategies that reference this
collection) and print the count in the preview so you see the blast radius
before confirming.

---

## Offer-level eligibility: decision rules vs. audiences

Every offer can have at most one of three eligibility states, chosen the same
way whether you're creating offers (`bulk_create_offers`'s `eligibility_rule`
/ `audience` columns) or attaching later
(`attach_offer_eligibility_rule`'s `eligibility_rule_id` / `audience` params):

- **None** — leave both fields empty. `itemConstraints:
  { profileConstraintType: "none" }`.
- **A decision/eligibility rule** — reference an existing `dps:eligibility-rule`
  by ID or exact name.
- **An audience** (RT-CDP segment) — reference by ID or exact name.

Adobe's offer-item schema only supports
`itemConstraints.profileConstraintType: "eligibilityRule"` for actually
restricting an offer. Attaching an audience works by auto-generating a real
eligibility rule that checks segment membership:

```
segmentMembership["ups"]["<segment-id>"]["status"].equals("realized", false)
```

named `Audience: <audience name>`. Repeat attach calls for the same audience
**reuse** that exact rule (matched by name) rather than creating a duplicate.

Providing both `eligibility_rule` and `audience` on the same offer/row is
rejected with a clear error rather than silently picking one.

---

## File layout

```
exd-accelerator-mcp/
├── src/
│   ├── server.js         ← buildMcpServer(config) + 47 tool definitions
│   ├── stdio.js          ← stdio entry (npm start) — for Claude Desktop
│   └── http-local.js     ← local HTTP server for testing the hosted route
├── api/
│   └── mcp.js            ← Vercel serverless route (Streamable HTTP)
├── scripts/
│   └── smoke.js          ← 29-check smoke test for stdio + HTTP
├── vercel.json           ← Vercel deployment config
├── package.json
├── .env.example
└── .gitignore
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing credentials` | CLIENT_ID/CLIENT_SECRET not set | Add to `.env` (local) or to your MCP client's header config (hosted) |
| `IMS token mint failed (401)` | Credentials invalid or revoked | Regenerate the OAuth Server-to-Server credential in Developer Console |
| `401 Oauth token is not valid` from Adobe | Credential lacks AEP access | The credential's product profile needs Experience Platform access for the target sandbox |
| `403 Forbidden` | Wrong org/sandbox for these creds | Check `ORG_ID` and `SANDBOX_NAME` |
| List offers returns 0 | Wrong `ITEM_CATALOG_ID` for the sandbox | Each sandbox has its own catalog ID |
| Bulk call exceeds 10s on Vercel Hobby | Function timeout | Upgrade to Pro (60s) or reduce `limit` |
| Custom XDM validation error on create | Sandbox schema has required fields you didn't supply | Read the error's field list, add the missing columns to your CSV/JSON |
| `MCP server connection lost` mid-bulk | Runtime hit its 60s hard cap | Lower `limit` and `chunk_size`; the tool will paginate itself |

---

## What this MCP does NOT do

- **AJO policy / campaign creation** — creates the ExD components (offers,
  strategies, placements) but not the final Journey Optimizer policy that ties
  them into a live delivery.
- **RT-CDP audience creation** — surfaces existing audiences via `list_audiences`
  but doesn't create new segments (that's Segmentation Service's job).
- **Cross-channel reporting** — would need AEP Query Service integration.
- **Anything unofficial or private** — this project only wraps documented,
  publicly available APIs. If Adobe changes those APIs, expect breakage until
  the wrapper catches up.

---

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please attach a smoke
run (`npm run smoke`) with your change.

---

## Maintainers

- **[Khushi Nayal](https://github.com/khushi-nayal)**
- **[Vikas Ohlan](https://github.com/Vikas-O7)**

## Ownership and license

Copyright © 2026 **Khushi Nayal** and **Vikas Ohlan**. Released under the
[Apache License 2.0](LICENSE).

This is a **personal side project** developed independently. It is **not an
Adobe product**, does not represent the views or work of any employer, and
carries no support relationship with Adobe Inc. Adobe, Adobe Experience
Platform, Adobe Journey Optimizer, and Adobe Experience Decisioning are
trademarks of Adobe Inc.; they appear in this documentation only to describe
which public APIs the software calls on the user's behalf.

**Intended for development sandbox exploration only.** Not for production use.
Apache 2.0's warranty disclaimer applies: the software is provided "AS IS"
without any warranty, express or implied.
