// ExD Accelerator MCP server — core module.
// Exports buildMcpServer(config) so transport entry points (stdio / Vercel) can wire it up.
//
// Config sources, in priority order:
//   1. Per-request HTTP headers (x-adobe-client-id, x-adobe-client-secret, x-adobe-sandbox, …)
//   2. process.env (CLIENT_ID, CLIENT_SECRET, SANDBOX_NAME, …)
//
// Tokens are minted automatically via OAuth client_credentials using the resolved
// CLIENT_ID + CLIENT_SECRET. The result is cached per client_id until ~1 min before expiry.
// Callers can still pass `access_token` to any tool to override.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Papa from "papaparse";

// ─── HEADER → CONFIG MAP ──────────────────────────────────────────────────────
// Headers win over env vars so a single Vercel deployment can serve multiple users
// who each supply their own credentials.
export const HEADER_MAP = Object.freeze({
  CLIENT_ID:                 "x-adobe-client-id",
  CLIENT_SECRET:             "x-adobe-client-secret",
  ORG_ID:                    "x-adobe-org-id",
  SANDBOX_NAME:              "x-adobe-sandbox",
  TENANT_ID:                 "x-adobe-tenant-id",
  DECISIONING_SCHEMA_URI:    "x-adobe-schema-uri",
  DECISIONING_SCHEMA_ALT_ID: "x-adobe-schema-alt-id",
  ITEM_CATALOG_ID:           "x-adobe-catalog-id",
  OOB_OFFER_CLASS:           "x-adobe-offer-class",
  ACCESS_TOKEN:              "x-adobe-access-token",
});

const DEFAULTS = {
  OOB_OFFER_CLASS: "https://ns.adobe.com/experience/decisioning/offeritem",
  BASE_SCHEMA_URL: "https://platform.adobe.io/data/foundation/schemaregistry",
  BASE_DPS_URL:    "https://platform.adobe.io/data/core/dps",
  IMS_TOKEN_URL:   "https://ims-na1.adobelogin.com/ims/token/v3",
  IMS_SCOPES:      "openid,AdobeID,session,read_organizations,additional_info.projectedProductContext,adobeio_api",
};

// Read a header in a case-insensitive way. Headers may arrive as a plain object,
// a Node http headers map, or a Web Standard Headers instance.
function headerLookup(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function getConfig(headers = {}) {
  const out = { ...DEFAULTS };
  for (const [key, hdr] of Object.entries(HEADER_MAP)) {
    out[key] = headerLookup(headers, hdr) || process.env[key] || out[key];
  }
  return out;
}

export function describeMissingConfig(config) {
  const required = ["CLIENT_ID","CLIENT_SECRET","ORG_ID","SANDBOX_NAME","TENANT_ID","DECISIONING_SCHEMA_URI","DECISIONING_SCHEMA_ALT_ID","ITEM_CATALOG_ID"];
  return required.filter(k => !config[k]);
}

// ─── TOKEN MINT + CACHE ───────────────────────────────────────────────────────
const tokenCache = new Map(); // client_id → { token, expiresAt }
const SCOPES_PROBE = DEFAULTS.IMS_SCOPES;

export async function mintToken(config) {
  if (config.ACCESS_TOKEN) return config.ACCESS_TOKEN;
  if (!config.CLIENT_ID || !config.CLIENT_SECRET) {
    throw new Error(
      "Missing credentials. Set CLIENT_ID and CLIENT_SECRET (env vars or x-adobe-client-id / x-adobe-client-secret headers), or pass access_token directly."
    );
  }
  const cached = tokenCache.get(config.CLIENT_ID);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(DEFAULTS.IMS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     config.CLIENT_ID,
      client_secret: config.CLIENT_SECRET,
      scope:         SCOPES_PROBE,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`IMS token mint failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text);
  const ttlMs = (parseInt(json.expires_in, 10) || 86400) * 1000;
  tokenCache.set(config.CLIENT_ID, { token: json.access_token, expiresAt: Date.now() + ttlMs });
  return json.access_token;
}

export function clearTokenCache() { tokenCache.clear(); }

// ─── HEADERS ──────────────────────────────────────────────────────────────────
function offerItemHeaders(token, config) {
  return {
    "Authorization":   `Bearer ${token}`,
    "x-api-key":        config.CLIENT_ID,
    "x-gw-ims-org-id":  config.ORG_ID,
    "x-sandbox-name":   config.SANDBOX_NAME,
    "Content-Type":     "application/json",
    "Accept":           "*,application/json",
    "x-schema-id":      config.DECISIONING_SCHEMA_URI,
  };
}
function dpsHeaders(token, config) {
  return {
    "Authorization":   `Bearer ${token}`,
    "x-api-key":        config.CLIENT_ID,
    "x-gw-ims-org-id":  config.ORG_ID,
    "x-sandbox-name":   config.SANDBOX_NAME,
    "Content-Type":     "application/json",
    "Accept":           "*,application/json",
  };
}
function placementHeaders(token, config) {
  return {
    "Authorization":   `Bearer ${token}`,
    "x-api-key":        config.CLIENT_ID,
    "x-gw-ims-org-id":  config.ORG_ID,
    "x-sandbox-name":   config.SANDBOX_NAME,
    "Content-Type":     "application/json",
  };
}
function schemaHeaders(token, config, accept) {
  return {
    "Authorization":   `Bearer ${token}`,
    "x-api-key":        config.CLIENT_ID,
    "x-gw-ims-org-id":  config.ORG_ID,
    "x-sandbox-name":   config.SANDBOX_NAME,
    "Content-Type":     "application/json",
    ...(accept ? { "Accept": accept } : {}),
  };
}

// ─── HTTP CALL with safe error handling + single retry on 5xx ─────────────────
// Adobe Platform APIs occasionally return transient 502/503/504. One retry with
// a short backoff turns those into a non-event for the caller.
async function apiCall(url, method, headers, body, { retry = true } = {}) {
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  async function attempt() {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      return { status: res.status, ok: res.ok, body: json };
    } catch (e) {
      return { status: 0, ok: false, body: { error: "network_error", message: e.message } };
    }
  }
  const first = await attempt();
  if (retry && (first.status === 0 || first.status === 502 || first.status === 503 || first.status === 504)) {
    await new Promise(r => setTimeout(r, 400));
    return attempt();
  }
  return first;
}

function extractItems(body) {
  return body.results || body.items || body._embedded?.items || body.data || [];
}

// ─── CONFIRMATION + CSV HELPERS ───────────────────────────────────────────────
function needsConfirmation(confirmed, preview) {
  if (confirmed) return null;
  return { content: [{ type: "text", text:
`⚠️  CONFIRMATION REQUIRED — no changes made yet
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${preview}

✅ To proceed, call this tool again with confirmed: true
❌ To cancel, simply do nothing.` }] };
}

function parseCSV(csvText) {
  const result = Papa.parse(String(csvText || "").trim(), { header: true, skipEmptyLines: true, dynamicTyping: false });
  return { columns: result.meta.fields || [], rows: result.data };
}

function inferXdmType(columnName, sampleValues) {
  const name  = columnName.toLowerCase();
  const nums  = sampleValues.filter(v => v && !isNaN(parseFloat(v)));
  const bools = sampleValues.filter(v => ["true","false","yes","no","1","0"].includes(String(v).toLowerCase()));
  if (name.includes("price") || name.includes("amount") || name.includes("score") || name.includes("discount"))
    return { type: "number",  "meta:xdmType": "double" };
  if (name.includes("priority") || name.includes("rank") || name.includes("count") || name.includes("qty"))
    return { type: "integer", "meta:xdmType": "int" };
  if (name.includes("date") || name.includes("expiry") || name.includes("start") || name.includes("end"))
    return { type: "string",  format: "date-time", "meta:xdmType": "date-time" };
  if (name.includes("url") || name.includes("image") || name.includes("link") || name.includes("href"))
    return { type: "string",  "meta:xdmType": "string" };
  if (name.includes("active") || name.includes("enabled") || name.includes("flag") ||
      bools.length > sampleValues.length * 0.7)
    return { type: "boolean", "meta:xdmType": "boolean" };
  if (nums.length > sampleValues.length * 0.8)
    return { type: "number",  "meta:xdmType": "double" };
  return { type: "string", "meta:xdmType": "string" };
}

function suggestRulesFromColumns(columns, tenantId) {
  const suggestions = [];
  const c = columns.map(x => x.toLowerCase());
  if (c.some(x => x.includes("category") || x.includes("type")))
    suggestions.push({ name: "Category match", pql: `profile.category.equals(offer._${tenantId}.category, false)`, why: "CSV has a category column" });
  if (c.some(x => x.includes("price") || x.includes("discount")))
    suggestions.push({ name: "High-value eligibility", pql: `profile.totalSpend >= 500`, why: "CSV has price/discount columns" });
  if (c.some(x => x.includes("region") || x.includes("country")))
    suggestions.push({ name: "Geo eligibility", pql: `profile.homeAddress.countryCode.equals("US", false)`, why: "CSV has location columns" });
  if (c.some(x => x.includes("tier") || x.includes("loyalty")))
    suggestions.push({ name: "Loyalty tier", pql: `profile.loyaltyTier.in(["gold", "platinum"])`, why: "CSV has tier columns" });
  if (!suggestions.length)
    suggestions.push({ name: "All visitors", pql: "true", why: "No targeting columns found" });
  return suggestions;
}

function suggestRankingFromColumns(columns) {
  const c = columns.map(x => x.toLowerCase());
  const suggestions = [];
  suggestions.push({ name: "Priority-first (static)", why: c.some(x => x.includes("priority")) ? "CSV has priority column" : "Good default" });
  if (c.some(x => x.includes("price") || x.includes("discount")))
    suggestions.push({ name: "Discount magnitude ranking", why: "CSV has price/discount data" });
  if (c.some(x => x.includes("date") || x.includes("expiry")))
    suggestions.push({ name: "Recency × priority hybrid", why: "CSV has date columns" });
  suggestions.push({ name: "Affinity score (AI model)", why: "Add after launch once data accumulates" });
  return suggestions;
}

function buildFieldsFromColumns(columns, sampleRow) {
  const skip = new Set(["id","name","description","status","start_date","end_date","startdate","enddate"]);
  const properties = {};
  for (const col of columns) {
    const key = col.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (skip.has(key)) continue;
    properties[key] = {
      title: col.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
      description: `Imported from CSV column: ${col}`,
      ...inferXdmType(col, sampleRow ? [sampleRow[col]].filter(Boolean) : []),
    };
  }
  return { properties };
}

// Sensible defaults: start = today UTC, end = +1 year. Fix for bug where defaults
// were hardcoded to past dates (2024-06-10).
function defaultDateRange() {
  const now   = new Date();
  const later = new Date(now.getTime());
  later.setUTCFullYear(later.getUTCFullYear() + 1);
  return { startDate: now.toISOString(), endDate: later.toISOString() };
}

function toIsoDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (!s) return null;
  if (s.includes("T")) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Helper for friendly error rendering on every tool.
function wrap(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      return { content: [{ type: "text", text:
`❌ Tool failed: ${e.message || String(e)}

If this is "Missing credentials", set CLIENT_ID + CLIENT_SECRET via env vars
(server side) or pass them as the x-adobe-client-id / x-adobe-client-secret
headers on the MCP connection.` }] };
    }
  };
}

// ─── MCP SERVER FACTORY ───────────────────────────────────────────────────────
export function buildMcpServer(initialConfig = {}) {
  const config = { ...DEFAULTS, ...initialConfig };
  const server = new McpServer({ name: "exd-accelerator", version: "2.0.0" });

  // Tool helper: resolves token and validates required config before any API call.
  const requireApiConfig = async (override) => {
    const cfg = { ...config };
    if (override) Object.assign(cfg, override);
    const missing = describeMissingConfig(cfg);
    if (missing.length) {
      throw new Error("Missing required config: " + missing.join(", "));
    }
    const token = override?.access_token || await mintToken(cfg);
    return { cfg, token };
  };

  // ════════ TOOL 1 — parse_csv_and_suggest ═════════════════════════════════════
  server.tool("parse_csv_and_suggest",
    "Parse a product/offer CSV, infer XDM types for each column, and suggest schema fields, eligibility rules, and ranking formulas. Always call this first — no data is written.",
    { csv_text: z.string().describe("Full CSV text content including headers and all rows") },
    wrap(async ({ csv_text }) => {
      const { columns, rows } = parseCSV(csv_text);
      const tenantId = config.TENANT_ID || "tenant";
      const { properties } = buildFieldsFromColumns(columns, rows[0] || {});
      const rules   = suggestRulesFromColumns(columns, tenantId);
      const ranking = suggestRankingFromColumns(columns);
      return { content: [{ type: "text", text:
`✅ CSV parsed — ${rows.length} rows | ${columns.length} columns
Sandbox : ${config.SANDBOX_NAME || "(not configured)"}
Tenant  : _${tenantId}

📐 SCHEMA FIELDS TO CREATE (under _${tenantId}):
${Object.entries(properties).map(([k,v]) => `  • ${k} (${v["meta:xdmType"]||v.type}) — "${v.title}"`).join("\n") || "  (no custom fields — all CSV columns map to OOB fields)"}

  OOB fields already available (no action needed):
  • itemName, itemDescription, itemPriority, start/endDate

🔒 SUGGESTED ELIGIBILITY RULES:
${rules.map((r,i) => `  ${i+1}. "${r.name}"\n     Why: ${r.why}\n     PQL: ${r.pql}`).join("\n\n")}

📊 SUGGESTED RANKING FORMULAS:
${ranking.map((r,i) => `  ${i+1}. "${r.name}" — ${r.why}`).join("\n")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 No data written. Say "proceed with schema creation" to push fields to AEP.` }] };
    })
  );

  // ════════ TOOL 2 — create_offer_metadata_fieldgroup ══════════════════════════
  server.tool("create_offer_metadata_fieldgroup",
    "Create a new XDM fieldgroup from CSV column names and attach it to the ExD decisioning schema. Will check for an existing fieldgroup with the same name first. Requires confirmed: true to execute — previews first.",
    {
      csv_text:        z.string().describe("Full CSV text — column names become schema fields"),
      fieldgroup_name: z.string().default("Offer Metadata - CSV Import").describe("Display name for the new fieldgroup"),
      confirmed:       z.boolean().default(false).describe("Set to true to execute. Leave false to preview only."),
      access_token:    z.string().optional().describe("Bearer token — optional, server will auto-mint if missing"),
    },
    wrap(async ({ csv_text, fieldgroup_name, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const { columns, rows } = parseCSV(csv_text);
      const { properties }    = buildFieldsFromColumns(columns, rows[0] || {});
      if (!Object.keys(properties).length)
        return { content: [{ type: "text", text: "⚠️ No custom fields found after filtering OOB fields (name, description, priority, dates)." }] };

      const fieldList = Object.entries(properties)
        .map(([k,v]) => `  • _${cfg.TENANT_ID}.${k} (${v["meta:xdmType"]||v.type}) — ${v.title}`)
        .join("\n");

      // Dedup check — look for an existing fieldgroup with the same title.
      const dupRes = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups?property=meta:intendedToExtend==${encodeURIComponent(cfg.OOB_OFFER_CLASS)}&orderby=title`,
        "GET", schemaHeaders(token, cfg, "application/vnd.adobe.xed-id+json"));
      let dupWarning = "";
      if (dupRes.ok) {
        const items = extractItems(dupRes.body);
        const match = items.find(fg => (fg.title || "").trim() === fieldgroup_name.trim());
        if (match) {
          dupWarning = `\n\n⚠️  A fieldgroup with the same title already exists:\n  • ${match.title}\n  • altId: ${match["meta:altId"]}\n  Creating another will produce a duplicate. Use detach_fieldgroup on the old one first if you want to replace it.`;
        }
      }

      const check = needsConfirmation(confirmed,
`FIELDGROUP TO CREATE:
  Name    : ${fieldgroup_name}
  Schema  : ${cfg.DECISIONING_SCHEMA_ALT_ID}
  Sandbox : ${cfg.SANDBOX_NAME}

FIELDS THAT WILL BE ADDED:
${fieldList}

This will:
  1. POST /tenant/fieldgroups to create the fieldgroup
  2. PATCH /tenant/schemas/${cfg.DECISIONING_SCHEMA_ALT_ID} to attach it${dupWarning}`);
      if (check) return check;

      const fgRes = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups`, "POST",
        schemaHeaders(token, cfg),
        {
          title: fieldgroup_name,
          description: `Auto-generated from CSV import. Columns: ${columns.join(", ")}`,
          type: "object",
          "meta:intendedToExtend": [cfg.OOB_OFFER_CLASS],
          definitions: {
            offerMetadata: {
              properties: {
                [`_${cfg.TENANT_ID}`]: { type: "object", properties, "meta:xdmType": "object" },
              },
            },
          },
          allOf: [{ "$ref": "#/definitions/offerMetadata" }],
        }
      );
      if (!fgRes.ok)
        return { content: [{ type: "text", text: `❌ Fieldgroup creation failed (${fgRes.status}):\n${JSON.stringify(fgRes.body, null, 2)}` }] };

      const fgId    = fgRes.body["$id"];
      const fgAltId = fgRes.body["meta:altId"];

      const patchRes = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/schemas/${cfg.DECISIONING_SCHEMA_ALT_ID}`, "PATCH",
        schemaHeaders(token, cfg),
        [
          { op: "add", path: "/meta:extends/-", value: fgId },
          { op: "add", path: "/allOf/-",        value: { "$ref": fgId } },
        ]
      );

      return { content: [{ type: "text", text:
`✅ Fieldgroup created and attached
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Fieldgroup ID : ${fgId}
meta:altId    : ${fgAltId}
Schema        : ${cfg.DECISIONING_SCHEMA_ALT_ID}

📐 Fields added under _${cfg.TENANT_ID}:
${fieldList}

Schema attach : ${patchRes.ok ? "✅ Success" : `⚠️ Failed (${patchRes.status}): ${JSON.stringify(patchRes.body)}`}

Next: Say "create offers" to bulk-create from your CSV.` }] };
    })
  );

  // ════════ TOOL 3 — bulk_create_offers ════════════════════════════════════════
  server.tool("bulk_create_offers",
    "Bulk-create ExD offer items from CSV rows. Each row becomes one offer. Requires confirmed: true to execute — previews payloads first. Use dry_run: true to inspect full JSON payloads.",
    {
      csv_text:         z.string().describe("Full CSV text"),
      lifecycle_status: z.enum(["draft","live","archived"]).default("draft"),
      dry_run:          z.boolean().default(false).describe("Returns full JSON payloads without calling the API"),
      confirmed:        z.boolean().default(false).describe("Set to true to execute the write. Leave false to preview."),
      access_token:     z.string().optional().describe("Bearer token — optional, server will auto-mint if missing"),
    },
    wrap(async ({ csv_text, lifecycle_status, dry_run, confirmed, access_token }) => {
      // Validate config up front so dry_run users get a clear error too.
      const { cfg, token } = dry_run && !confirmed
        ? { cfg: { ...config, ...(describeMissingConfig(config).length ? {} : {}) }, token: null }
        : await requireApiConfig({ access_token });

      const { columns, rows } = parseCSV(csv_text);
      const colLower  = col => col.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const colMap    = {};
      for (const c of columns) colMap[colLower(c)] = c;
      const findCol   = keys => { const k = keys.find(k => colMap[k]); return k ? colMap[k] : null; };
      const { startDate: defStart, endDate: defEnd } = defaultDateRange();

      const payloads = [];
      for (let i = 0; i < rows.length; i++) {
        const row       = rows[i];
        const nameCol   = findCol(["name","offer_name","title","item_name"]);
        const descCol   = findCol(["description","desc","summary"]);
        const prioCol   = findCol(["priority","rank","item_priority"]);
        const startCol  = findCol(["start_date","startdate","start","valid_from"]);
        const endCol    = findCol(["end_date","enddate","expiry","expiry_date","valid_to"]);
        const itemName  = nameCol  ? row[nameCol]              : `Offer ${i+1}`;
        const itemDesc  = descCol  ? row[descCol]              : "";
        const itemPrio  = prioCol  ? parseInt(row[prioCol])||1 : 1;
        const startIso  = (startCol && toIsoDate(row[startCol])) || defStart;
        const endIso    = (endCol   && toIsoDate(row[endCol]))   || defEnd;
        const oobKeys   = new Set([colLower(nameCol||""),colLower(descCol||""),colLower(prioCol||""),colLower(startCol||""),colLower(endCol||""),"id"]);
        const custom    = {};
        for (const col of columns) {
          const key = colLower(col);
          if (!oobKeys.has(key) && row[col] !== undefined && row[col] !== "") {
            const n = parseFloat(row[col]);
            custom[key] = !isNaN(n) && /^-?\d+(\.\d+)?$/.test(String(row[col]).trim()) ? n : row[col];
          }
        }
        payloads.push({
          name: itemName,
          payload: {
            _experience: {
              decisioning: {
                offeritem:    { lifecycleStatus: lifecycle_status },
                decisionitem: {
                  itemCalendarConstraints: { startDate: startIso, endDate: endIso },
                  itemCatalogID:   cfg.ITEM_CATALOG_ID,
                  itemConstraints: { profileConstraintType: "none" },
                  itemDescription: itemDesc,
                  itemName,
                  itemPriority:    itemPrio,
                },
              },
            },
            ...(Object.keys(custom).length ? { [`_${cfg.TENANT_ID}`]: custom } : {}),
          },
        });
      }

      if (dry_run) return { content: [{ type: "text", text:
`🔍 DRY RUN — ${payloads.length} offers would be created (status: ${lifecycle_status}):
${payloads.map((p,i) => `Row ${i+1}: "${p.name}"\n${JSON.stringify(p.payload, null, 2)}`).join("\n\n")}

Call again with dry_run: false and confirmed: true to execute.` }] };

      const preview = `OFFERS TO CREATE: ${payloads.length} offer items
Status   : ${lifecycle_status}
Sandbox  : ${cfg.SANDBOX_NAME}
Catalog  : ${cfg.ITEM_CATALOG_ID}

OFFER NAMES:
${payloads.map((p,i) => `  ${i+1}. ${p.name}`).join("\n")}

This will POST ${payloads.length} requests to /offer-items.`;
      const check = needsConfirmation(confirmed, preview);
      if (check) return check;

      // Run in chunks so we don't blow past Vercel's 60s function timeout on
      // large CSVs, but stay well under DPS rate limits.
      const CHUNK_SIZE = 5;
      const results = [], errors = [];
      for (let i = 0; i < payloads.length; i += CHUNK_SIZE) {
        const chunk = payloads.slice(i, i + CHUNK_SIZE);
        const settled = await Promise.all(chunk.map(p =>
          apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items`, "POST", offerItemHeaders(token, cfg), p.payload)
            .then(res => ({ p, res }))
        ));
        for (const { p, res } of settled) {
          if (res.ok) results.push({ name: p.name, id: res.body.id });
          else        errors.push({ name: p.name, error: JSON.stringify(res.body) });
        }
      }

      return { content: [{ type: "text", text:
`📦 BULK OFFER CREATION COMPLETE
✅ Created : ${results.length}  |  ❌ Failed: ${errors.length}
${results.map(r => `  ✅ "${r.name}" → ${r.id}`).join("\n")}
${errors.length ? `\nErrors:\n${errors.map(e => `  ❌ "${e.name}" → ${e.error}`).join("\n")}` : ""}

Next: Say "create collections" to group these offers.` }] };
    })
  );

  // ════════ TOOL 4 — create_collection ═════════════════════════════════════════
  server.tool("create_collection",
    "Create an offer item collection with a filter constraint. Requires confirmed: true to execute.",
    {
      name:              z.string().describe("Collection display name"),
      description:       z.string().default(""),
      filter_type:       z.enum(["all","by_name","by_category","by_custom_field","by_priority_gte"]).describe("How to filter offers into this collection"),
      filter_value:      z.string().optional().describe("Value to filter on — required for all filter types except 'all'"),
      custom_field_path: z.string().optional().describe("Tenant field path for by_custom_field e.g. category"),
      confirmed:         z.boolean().default(false).describe("Set to true to execute the write."),
      access_token:      z.string().optional(),
    },
    wrap(async ({ name, description, filter_type, filter_value, custom_field_path, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      let uiModel;
      if (filter_type === "all")
        uiModel = `{"operator":"isNotNull","value":{"left":"_experience.decisioning.decisionitem.itemName"}}`;
      else if (filter_type === "by_name")
        uiModel = JSON.stringify({ operator:"equals", value:{ left:"_experience.decisioning.decisionitem.itemName", right:filter_value } });
      else if (filter_type === "by_category" || filter_type === "by_custom_field")
        uiModel = JSON.stringify({ operator:"equals", value:{ left:`_${cfg.TENANT_ID}.${custom_field_path||"category"}`, right:filter_value } });
      else if (filter_type === "by_priority_gte") {
        const n = Number.parseInt(filter_value, 10);
        const threshold = Number.isFinite(n) ? n : 1;
        uiModel = JSON.stringify({ operator:"greaterThan", value:{ left:"_experience.decisioning.decisionitem.itemPriority", right: threshold } });
      }

      const check = needsConfirmation(confirmed,
`COLLECTION TO CREATE:
  Name       : ${name}
  Description: ${description || "(none)"}
  Filter     : ${filter_type}${filter_value ? ` = "${filter_value}"` : ""}
  Catalog    : ${cfg.ITEM_CATALOG_ID}
  Sandbox    : ${cfg.SANDBOX_NAME}

This will POST to /item-collections.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/item-collections`, "POST",
        dpsHeaders(token, cfg),
        { name, description, constraints:[{ itemCatalogId: cfg.ITEM_CATALOG_ID, uiModel }] }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Collection creation failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Collection created
Name   : ${name}
ID     : ${res.body.id}
Filter : ${filter_type}${filter_value ? ` = "${filter_value}"` : ""}
💡 Save this ID: ${res.body.id}` }] };
    })
  );

  // ════════ TOOL 5 — create_eligibility_rule ═══════════════════════════════════
  server.tool("create_eligibility_rule",
    "Create a PQL eligibility rule for Experience Decisioning. Requires confirmed: true to execute.",
    {
      name:           z.string().describe("Rule display name"),
      description:    z.string().default(""),
      pql_expression: z.string().describe("PQL expression e.g. profile.loyaltyTier.in([\"gold\",\"platinum\"]) or true for all visitors"),
      confirmed:      z.boolean().default(false),
      access_token:   z.string().optional(),
    },
    wrap(async ({ name, description, pql_expression, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = needsConfirmation(confirmed,
`ELIGIBILITY RULE TO CREATE:
  Name    : ${name}
  PQL     : ${pql_expression}
  Sandbox : ${cfg.SANDBOX_NAME}

This will POST to /offer-rules.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-rules`, "POST",
        dpsHeaders(token, cfg),
        { name, description, exdRule: true, condition:{ type:"PQL", format:"pql/text", value:pql_expression } }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Rule creation failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Eligibility rule created
Name : ${name}
ID   : ${res.body.id}
PQL  : ${pql_expression}
💡 Save this ID: ${res.body.id}` }] };
    })
  );

  // ════════ TOOL 6 — create_ranking_formula ════════════════════════════════════
  server.tool("create_ranking_formula",
    "Create a ranking formula for Experience Decisioning. Requires confirmed: true to execute.",
    {
      name:              z.string().describe("Formula display name"),
      description:       z.string().default(""),
      formula_type:      z.enum(["static_priority","custom_field","recency_priority_hybrid","custom_pql"]),
      custom_field_name: z.string().optional(),
      custom_pql:        z.string().optional(),
      confirmed:         z.boolean().default(false),
      access_token:      z.string().optional(),
    },
    wrap(async ({ name, description, formula_type, custom_field_name, custom_pql, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      let pql;
      if      (formula_type === "static_priority")
        pql = `if(offer._experience.decisioning.decisionitem.itemPriority.isNotNull(), offer._experience.decisioning.decisionitem.itemPriority, 1)`;
      else if (formula_type === "custom_field")
        pql = `if(offer._${cfg.TENANT_ID}.${custom_field_name||"offerPriorityScore"}.isNotNull(), offer._${cfg.TENANT_ID}.${custom_field_name||"offerPriorityScore"}, 0)`;
      else if (formula_type === "recency_priority_hybrid")
        pql = `if(offer._experience.decisioning.decisionitem.itemPriority.isNotNull(), offer._experience.decisioning.decisionitem.itemPriority, 0) + if(offer._experience.decisioning.decisionitem.itemCalendarConstraints.startDate.isNotNull(), 1, 0)`;
      else
        pql = custom_pql || "1";

      const check = needsConfirmation(confirmed,
`RANKING FORMULA TO CREATE:
  Name    : ${name}
  Type    : ${formula_type}
  PQL     : ${pql}
  Sandbox : ${cfg.SANDBOX_NAME}

This will POST to /ranking-formulas.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/ranking-formulas`, "POST",
        dpsHeaders(token, cfg),
        {
          name, description, exdFunction: true,
          returnType: { type:"integer" },
          expression: { type:"PQL", format:"pql/text", value:pql },
          definedOn:  { offer:{ schema:{ altId:"_experience.offer-management.personalized-offer", version:"0" } } },
        }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Ranking formula failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Ranking formula created
Name : ${name}
ID   : ${res.body.id}
PQL  : ${pql}
💡 Save this ID: ${res.body.id}` }] };
    })
  );

  // ════════ TOOL 7 — create_selection_strategy ═════════════════════════════════
  server.tool("create_selection_strategy",
    "Wire a collection, eligibility rule, and ranking formula into a selection strategy. Requires confirmed: true to execute.",
    {
      name:                z.string(),
      description:         z.string().default(""),
      collection_id:       z.string().describe("ID of the item collection e.g. dps:item-collection:xxxxx"),
      eligibility_rule_id: z.string().optional().describe("ID of the eligibility rule. Omit for all visitors."),
      ranking_formula_id:  z.string().optional().describe("ID of the ranking formula. Omit for static priority."),
      priority:            z.number().default(1).describe("Static priority score (1 = highest) when no ranking formula is set"),
      confirmed:           z.boolean().default(false),
      access_token:        z.string().optional(),
    },
    wrap(async ({ name, description, collection_id, eligibility_rule_id, ranking_formula_id, priority, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = needsConfirmation(confirmed,
`SELECTION STRATEGY TO CREATE:
  Name        : ${name}
  Collection  : ${collection_id}
  Eligibility : ${eligibility_rule_id || "None (all visitors)"}
  Ranking     : ${ranking_formula_id  || "Static priority"}
  Priority    : ${priority}
  Sandbox     : ${cfg.SANDBOX_NAME}

This will POST to /selection-strategies.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/selection-strategies`, "POST",
        dpsHeaders(token, cfg),
        {
          name, description,
          rank: ranking_formula_id
            ? { priority, order:{ orderEvaluationType:"rankingStrategy", rankingStrategy:ranking_formula_id } }
            : { priority, order:{ orderEvaluationType:"static" } },
          profileConstraint: eligibility_rule_id
            ? { profileConstraintType:"eligibilityRule", eligibilityRule:eligibility_rule_id }
            : { profileConstraintType:"none" },
          optionSelection: { filter:collection_id },
        }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Selection strategy failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Selection strategy created
Name        : ${name}
ID          : ${res.body.id}
Collection  : ${collection_id}
Eligibility : ${eligibility_rule_id || "None (all visitors)"}
Ranking     : ${ranking_formula_id  || "Static priority"}
💡 Save this ID: ${res.body.id}` }] };
    })
  );

  // ════════ TOOL 8 — create_placement ══════════════════════════════════════════
  server.tool("create_placement",
    "Create a channel placement for Experience Decisioning. Uses /exd-placements endpoint. Requires confirmed: true to execute.",
    {
      name:         z.string(),
      description:  z.string().default(""),
      channel:      z.enum([
        "https://ns.adobe.com/xdm/channel-types/web",
        "https://ns.adobe.com/xdm/channel-types/email",
        "https://ns.adobe.com/xdm/channel-types/push",
        "https://ns.adobe.com/xdm/channel-types/mobile",
        "https://ns.adobe.com/xdm/channel-types/in-app",
      ]),
      status:       z.enum(["active","archived"]).default("active"),
      confirmed:    z.boolean().default(false),
      access_token: z.string().optional(),
    },
    wrap(async ({ name, description, channel, status, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = needsConfirmation(confirmed,
`PLACEMENT TO CREATE:
  Name    : ${name}
  Channel : ${channel}
  Status  : ${status}
  Sandbox : ${cfg.SANDBOX_NAME}

This will POST to /exd-placements.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/exd-placements`, "POST",
        placementHeaders(token, cfg),
        { name, description, channel, status }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Placement failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Placement created
Name    : ${name}
ID      : ${res.body.id}
Channel : ${channel}
Status  : ${status}` }] };
    })
  );

  // ════════ TOOL 9 — get_offer_item ════════════════════════════════════════════
  server.tool("get_offer_item",
    "Look up a single offer item by its DPS ID. Read-only.",
    {
      offer_id:     z.string(),
      access_token: z.string().optional(),
    },
    wrap(async ({ offer_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items/${offer_id}`, "GET", offerItemHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 10 — list_offer_items ═════════════════════════════════════════
  server.tool("list_offer_items",
    "List all offer items in the ExD catalog with pagination. Read-only.",
    {
      limit:        z.number().default(20),
      offset:       z.number().default(0),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, offset, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-items?limit=${limit}&offset=${offset}`, "GET",
        offerItemHeaders(token, cfg)
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      if (!items.length)
        return { content: [{ type: "text", text:
`⚠️ 0 items returned.
Total reported by API : ${res.body.total ?? res.body.count ?? "unknown"}
Raw response          : ${JSON.stringify(res.body, null, 2)}` }] };

      return { content: [{ type: "text", text:
`📋 Offer items (${items.length} of ${res.body.total ?? res.body.count ?? "?"}):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(i => {
  const d = i._experience?.decisioning?.decisionitem;
  const s = i._experience?.decisioning?.offeritem?.lifecycleStatus || "-";
  return `  • ${d?.itemName||"unnamed"} | Priority: ${d?.itemPriority??"-"} | Status: ${s} | ID: ${i.id||"?"}`;
}).join("\n")}
${res.body._links?.next ? `\nNext page: call with offset ${offset + limit}` : ""}` }] };
    })
  );

  // ════════ TOOL 11 — update_offer_item ════════════════════════════════════════
  server.tool("update_offer_item",
    "Update fields on an existing offer item using JSON Patch operations. Requires confirmed: true to execute.",
    {
      offer_id:     z.string(),
      patches:      z.array(z.object({
        op:    z.enum(["replace","add","remove"]),
        path:  z.string(),
        value: z.any().optional(),
      })),
      confirmed:    z.boolean().default(false),
      access_token: z.string().optional(),
    },
    wrap(async ({ offer_id, patches, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = needsConfirmation(confirmed,
`OFFER ITEM TO UPDATE:
  Offer ID : ${offer_id}
  Sandbox  : ${cfg.SANDBOX_NAME}

PATCHES TO APPLY:
${patches.map(p => `  ${p.op} ${p.path}${p.value !== undefined ? ` = ${JSON.stringify(p.value)}` : ""}`).join("\n")}

This will PATCH /offer-items/${offer_id}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-items/${offer_id}`, "PATCH",
        offerItemHeaders(token, cfg), patches
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Offer ${offer_id} updated successfully`
        : `❌ Update failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 12 — add_schema_field ═════════════════════════════════════════
  server.tool("add_schema_field",
    "Add a single new field to an existing tenant fieldgroup. Requires confirmed: true to execute.",
    {
      fieldgroup_id:     z.string(),
      field_name:        z.string(),
      field_title:       z.string(),
      field_description: z.string().default(""),
      field_type:        z.enum(["string","integer","number","boolean"]).default("string"),
      definition_key:    z.string().default("offerMetadata"),
      confirmed:         z.boolean().default(false),
      access_token:      z.string().optional(),
    },
    wrap(async ({ fieldgroup_id, field_name, field_title, field_description, field_type, definition_key, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const xdmTypeMap = { string:"string", integer:"int", number:"double", boolean:"boolean" };

      const check = needsConfirmation(confirmed,
`SCHEMA FIELD TO ADD:
  Fieldgroup    : ${fieldgroup_id}
  Field name    : _${cfg.TENANT_ID}.${field_name}
  Type          : ${field_type} (${xdmTypeMap[field_type]})
  Title         : ${field_title}
  Definition key: ${definition_key}

Path: /definitions/${definition_key}/properties/_${cfg.TENANT_ID}/properties/${field_name}

This will PATCH /tenant/fieldgroups/${fieldgroup_id}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups/${fieldgroup_id}`, "PATCH",
        schemaHeaders(token, cfg),
        [{ op:"add",
           path:`/definitions/${definition_key}/properties/_${cfg.TENANT_ID}/properties/${field_name}`,
           value:{ title:field_title, description:field_description, type:field_type, "meta:xdmType":xdmTypeMap[field_type] } }]
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Field _${cfg.TENANT_ID}.${field_name} (${field_type}) added to ${fieldgroup_id}`
        : `❌ Failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 13 — deprecate_schema_field ═══════════════════════════════════
  server.tool("deprecate_schema_field",
    "Mark a custom tenant fieldgroup field as deprecated. The field remains but is flagged. For OOB Adobe fields use deprecate_oob_field. Requires confirmed: true to execute.",
    {
      fieldgroup_id:  z.string(),
      field_name:     z.string(),
      definition_key: z.string().default("offerMetadata"),
      confirmed:      z.boolean().default(false),
      access_token:   z.string().optional(),
    },
    wrap(async ({ fieldgroup_id, field_name, definition_key, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const path = `/definitions/${definition_key}/properties/_${cfg.TENANT_ID}/properties/${field_name}/meta:status`;

      const check = needsConfirmation(confirmed,
`FIELD TO DEPRECATE:
  Fieldgroup : ${fieldgroup_id}
  Field      : _${cfg.TENANT_ID}.${field_name}
  Action     : Set meta:status = "deprecated"
  Path       : ${path}

⚠️  The field will still exist in the schema but will be marked as deprecated.

This will PATCH /tenant/fieldgroups/${fieldgroup_id}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups/${fieldgroup_id}`, "PATCH",
        schemaHeaders(token, cfg),
        [{ op:"add", path, value:"deprecated" }]
      );
      if (!res.ok)
        return { content: [{ type: "text", text:
`❌ Deprecation failed (${res.status}):
${JSON.stringify(res.body, null, 2)}

💡 If 422: the definition_key may be wrong. Call get_fieldgroup to find the correct key.` }] };

      return { content: [{ type: "text", text:
`✅ Field deprecated
Fieldgroup : ${fieldgroup_id}
Field      : _${cfg.TENANT_ID}.${field_name}
Status     : deprecated` }] };
    })
  );

  // ════════ TOOL 14 — deprecate_oob_field ══════════════════════════════════════
  server.tool("deprecate_oob_field",
    "Deprecate an OOB Adobe-managed field on the decisioning schema via a descriptor. Use for standard fields like itemDescription, itemName. For custom tenant fields use deprecate_schema_field. Requires confirmed: true.",
    {
      field_path:   z.string().describe("JSON pointer path to the field e.g. /_experience/decisioning/decisionitem/itemDescription"),
      confirmed:    z.boolean().default(false),
      access_token: z.string().optional(),
    },
    wrap(async ({ field_path, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = needsConfirmation(confirmed,
`OOB FIELD TO DEPRECATE VIA DESCRIPTOR:
  Schema     : ${cfg.DECISIONING_SCHEMA_URI}
  Field path : ${field_path}
  Descriptor : xdm:descriptorDeprecated

⚠️  This does not modify the base schema — it creates a deprecation descriptor.

This will POST to /tenant/descriptors.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/descriptors`, "POST",
        schemaHeaders(token, cfg),
        {
          "@type":              "xdm:descriptorDeprecated",
          "xdm:sourceSchema":   cfg.DECISIONING_SCHEMA_URI,
          "xdm:sourceVersion":  1,
          "xdm:sourceProperty": field_path,
        }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ OOB deprecation failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ OOB field deprecated via descriptor
Schema      : ${cfg.DECISIONING_SCHEMA_URI}
Field path  : ${field_path}
Descriptor  : ${res.body["@id"] || res.body.id || "created"}` }] };
    })
  );

  // ════════ TOOL 15 — detach_fieldgroup ════════════════════════════════════════
  server.tool("detach_fieldgroup",
    "Safely remove a fieldgroup from the decisioning schema. Always shows a dry-run preview first. Requires confirmed: true to execute the removal.",
    {
      fieldgroup_id: z.string().describe("Fieldgroup meta:altId OR full $id URI to detach"),
      confirmed:     z.boolean().default(false),
      access_token:  z.string().optional(),
    },
    wrap(async ({ fieldgroup_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });

      const schemaRes = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/schemas/${cfg.DECISIONING_SCHEMA_ALT_ID}`, "GET",
        schemaHeaders(token, cfg, "application/vnd.adobe.xed+json; version=1")
      );
      if (!schemaRes.ok)
        return { content: [{ type: "text", text: `❌ Could not fetch schema (${schemaRes.status}):\n${JSON.stringify(schemaRes.body, null, 2)}` }] };

      const schema   = schemaRes.body;
      const allOf    = schema.allOf            || [];
      const extends_ = schema["meta:extends"]  || [];

      let fgUri = fieldgroup_id;
      if (!fieldgroup_id.startsWith("https://")) {
        fgUri = fieldgroup_id
          .replace(/^_/, "https://ns.adobe.com/")
          .replace(/\.mixins\./,     "/mixins/")
          .replace(/\.fieldgroups\./, "/fieldgroups/");
      }
      let fgAltId = fieldgroup_id;
      if (fieldgroup_id.startsWith("https://")) {
        fgAltId = fieldgroup_id
          .replace("https://ns.adobe.com/", "_")
          .replace("/mixins/",     ".mixins.")
          .replace("/fieldgroups/", ".fieldgroups.");
      }
      const fgHash = fgAltId.split(".mixins.")[1] || fgAltId.split(".fieldgroups.")[1] || "";

      const allOfIndices   = [];
      const extendsIndices = [];
      allOf.forEach((e, i) => {
        const ref = e["$ref"] || "";
        if (ref === fgUri || ref === fgAltId || (fgHash && ref.includes(fgHash))) allOfIndices.push(i);
      });
      extends_.forEach((e, i) => {
        if (e === fgUri || e === fgAltId || (fgHash && e.includes(fgHash))) extendsIndices.push(i);
      });

      if (!allOfIndices.length && !extendsIndices.length) {
        return { content: [{ type: "text", text:
`⚠️ Fieldgroup not found in schema
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Searched for:
  URI   : ${fgUri}
  altId : ${fgAltId}

Current allOf entries (${allOf.length}):
${allOf.map((e,i) => `  [${i}] ${e["$ref"] || "(no $ref)"}`).join("\n") || "  (empty)"}

Current meta:extends entries (${extends_.length}):
${extends_.map((e,i) => `  [${i}] ${e}`).join("\n") || "  (empty)"}

💡 Copy the exact $ref from allOf above and pass it as fieldgroup_id.` }] };
      }

      const allOfSorted   = [...allOfIndices].sort((a,b) => b-a);
      const extendsSorted = [...extendsIndices].sort((a,b) => b-a);
      const patches = [
        ...allOfSorted.map(i   => ({ op:"remove", path:`/allOf/${i}` })),
        ...extendsSorted.map(i => ({ op:"remove", path:`/meta:extends/${i}` })),
      ];

      const previewLines = [
        ...allOfIndices.map(i   => `  REMOVE allOf[${i}]  → "${allOf[i]["$ref"]}"`),
        ...extendsIndices.map(i => `  REMOVE meta:extends[${i}] → "${extends_[i]}"`),
      ].join("\n");

      const check = needsConfirmation(confirmed,
`FIELDGROUP TO DETACH:
  URI     : ${fgUri}
  Schema  : ${cfg.DECISIONING_SCHEMA_ALT_ID}
  Sandbox : ${cfg.SANDBOX_NAME}

CHANGES THAT WILL BE MADE:
${previewLines}

⚠️  This will hide the fieldgroup's fields from the offer UI.
   The fieldgroup itself will NOT be deleted from the registry.

This will PATCH /tenant/schemas/${cfg.DECISIONING_SCHEMA_ALT_ID}.`);
      if (check) return check;

      const patchRes = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/schemas/${cfg.DECISIONING_SCHEMA_ALT_ID}`, "PATCH",
        schemaHeaders(token, cfg),
        patches
      );
      if (!patchRes.ok)
        return { content: [{ type: "text", text:
`❌ Detach failed (${patchRes.status}):
${JSON.stringify(patchRes.body, null, 2)}

Patches attempted:
${JSON.stringify(patches, null, 2)}` }] };

      return { content: [{ type: "text", text:
`✅ Fieldgroup detached successfully
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Schema         : ${cfg.DECISIONING_SCHEMA_ALT_ID}
Fieldgroup     : ${fgUri}
Schema version : ${patchRes.body.version || "updated"}

Patches applied:
${patches.map(p => `  ${p.op} ${p.path}`).join("\n")}` }] };
    })
  );

  // ════════ TOOL 16 — get_setup_summary ════════════════════════════════════════
  server.tool("get_setup_summary",
    "Full read-only inventory of all ExD resources in the sandbox — offers, collections, rules, formulas, strategies, and placements.",
    { access_token: z.string().optional() },
    wrap(async ({ access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const [offersRes, collectionsRes, rulesRes, rankingRes, strategiesRes, placementsRes] = await Promise.all([
        apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items?limit=100`,                                      "GET", offerItemHeaders(token, cfg)),
        apiCall(`${DEFAULTS.BASE_DPS_URL}/item-collections?limit=100`,                                 "GET", dpsHeaders(token, cfg)),
        apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-rules?property=exdRule%3D%3Dtrue&limit=100`,           "GET", dpsHeaders(token, cfg)),
        apiCall(`${DEFAULTS.BASE_DPS_URL}/ranking-formulas?property=exdFunction%3D%3Dtrue&limit=100`,  "GET", dpsHeaders(token, cfg)),
        apiCall(`${DEFAULTS.BASE_DPS_URL}/selection-strategies?limit=100`,                             "GET", dpsHeaders(token, cfg)),
        apiCall(`${DEFAULTS.BASE_DPS_URL}/exd-placements?limit=100`,                                   "GET", placementHeaders(token, cfg)),
      ]);
      const fmt = (res, label) => {
        if (!res.ok) return `  ⚠️ ${label} failed (${res.status})`;
        const items = extractItems(res.body);
        if (!items.length) return `  (none — total: ${res.body.total ?? res.body.count ?? "?"})`;
        return items.map(i => {
          const name = i.name || i._experience?.decisioning?.decisionitem?.itemName || i.id;
          return `  • ${name} (${i.id || "?"})`;
        }).join("\n");
      };
      return { content: [{ type: "text", text:
`📊 ExD SETUP SUMMARY — ${cfg.SANDBOX_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Schema URI : ${cfg.DECISIONING_SCHEMA_URI}
Catalog    : ${cfg.ITEM_CATALOG_ID}

📦 OFFER ITEMS (${offersRes.ok ? (offersRes.body.total ?? offersRes.body.count ?? extractItems(offersRes.body).length) : "error"} total):
${fmt(offersRes, "Offers")}

🗂️  COLLECTIONS:
${fmt(collectionsRes, "Collections")}

🔒 ELIGIBILITY RULES:
${fmt(rulesRes, "Rules")}

📊 RANKING FORMULAS:
${fmt(rankingRes, "Formulas")}

🎯 SELECTION STRATEGIES:
${fmt(strategiesRes, "Strategies")}

📍 PLACEMENTS:
${fmt(placementsRes, "Placements")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 What would you like to do next?` }] };
    })
  );

  // ════════ TOOL 17 — lookup_decisioning_schema ════════════════════════════════
  // Fixed: also surface meta:extends entries that look like fieldgroups, since
  // xed-full resolves the allOf array into the merged schema and the original
  // allOf $refs are no longer present.
  server.tool("lookup_decisioning_schema",
    "Fetch the full resolved Personalized Offer Items decisioning schema — all fieldgroups, OOB fields, and custom tenant fields. Read-only.",
    {
      include_deprecated: z.boolean().default(false),
      access_token:       z.string().optional(),
    },
    wrap(async ({ include_deprecated, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const accept = include_deprecated
        ? "application/vnd.adobe.xed-deprecatefield+json; version=1"
        : "application/vnd.adobe.xed-full+json; version=1";

      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/schemas/${cfg.DECISIONING_SCHEMA_ALT_ID}`, "GET",
        schemaHeaders(token, cfg, accept)
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Schema lookup failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const s        = res.body;
      const allOf    = s.allOf || [];
      const extends_ = s["meta:extends"] || [];

      // Collect fieldgroup-shaped refs from BOTH allOf and meta:extends. xed-full
      // resolves allOf so prefer meta:extends for the canonical list.
      const fgRefs = new Set();
      for (const e of allOf)    { const r = e["$ref"]||""; if (r && !r.startsWith("#")) fgRefs.add(r); }
      for (const e of extends_) { if (e && typeof e === "string") fgRefs.add(e); }

      const tenantFGs = [...fgRefs].filter(r => r.includes(cfg.TENANT_ID));
      const oobRefs   = [...fgRefs].filter(r => !r.includes(cfg.TENANT_ID));

      const tenantProps = [];
      for (const [, defVal] of Object.entries(s.definitions || {})) {
        const ns = defVal?.properties?.[`_${cfg.TENANT_ID}`]?.properties || {};
        for (const [k,v] of Object.entries(ns)) {
          const dep   = v?.["meta:status"]==="deprecated" ? " ⚠️ DEPRECATED" : "";
          const type  = v?.["meta:xdmType"] || v?.type || "?";
          const title = v?.title || k;
          const desc  = v?.description ? ` — ${v.description}` : "";
          const enums = v?.["meta:enum"] ? ` [enum: ${Object.keys(v["meta:enum"]).join(", ")}]` : "";
          tenantProps.push(`    • _${cfg.TENANT_ID}.${k} (${type})${dep}\n      Title: ${title}${desc}${enums}`);
        }
      }
      if (!tenantProps.length && s.properties?.[`_${cfg.TENANT_ID}`]?.properties) {
        for (const [k,v] of Object.entries(s.properties[`_${cfg.TENANT_ID}`].properties)) {
          const dep  = v?.["meta:status"]==="deprecated" ? " ⚠️ DEPRECATED" : "";
          const type = v?.["meta:xdmType"] || v?.type || "?";
          tenantProps.push(`    • _${cfg.TENANT_ID}.${k} (${type})${dep}\n      Title: ${v?.title||k}`);
        }
      }
      if (!tenantProps.length) {
        for (const block of allOf) {
          const ns = block?.properties?.[`_${cfg.TENANT_ID}`]?.properties || {};
          for (const [k,v] of Object.entries(ns)) {
            tenantProps.push(`    • _${cfg.TENANT_ID}.${k} (${v?.["meta:xdmType"]||v?.type||"?"})\n      Title: ${v?.title||k}`);
          }
        }
      }

      const oobFields = [];
      if (s.properties) {
        for (const [propKey, propVal] of Object.entries(s.properties)) {
          if (propKey === `_${cfg.TENANT_ID}`) continue;
          oobFields.push(`    • ${propKey} (${propVal?.["meta:xdmType"]||propVal?.type||"object"})`);
          if (propVal?.properties) {
            for (const [sub,subVal] of Object.entries(propVal.properties)) {
              oobFields.push(`      └─ ${sub} (${subVal?.["meta:xdmType"]||subVal?.type||"object"})`);
            }
          }
        }
      }

      const debugBlock = !tenantProps.length
        ? `\n⚠️ No tenant fields found inline. Call list_schema_fieldgroups then get_fieldgroup on the tenant fieldgroups below to inspect them directly.`
        : "";

      return { content: [{ type: "text", text:
`📋 PERSONALIZED OFFER ITEMS — DECISIONING SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title        : ${s.title || "Personalized Offer Items - Experience Decisioning"}
Schema URI   : ${cfg.DECISIONING_SCHEMA_URI}
Schema altId : ${cfg.DECISIONING_SCHEMA_ALT_ID}
Version      : ${s.version || "?"}
Class        : ${s["meta:class"] || "?"}
Sandbox      : ${cfg.SANDBOX_NAME}
Accept used  : ${accept}

📦 FIELDGROUPS ATTACHED TO SCHEMA (${fgRefs.size} total — from allOf + meta:extends):
  OOB Adobe-managed (${oobRefs.length}):
${oobRefs.map(r=>`    • ${r}`).join("\n") || "    (none)"}
  Tenant custom (${tenantFGs.length}):
${tenantFGs.map(r=>`    • ${r}`).join("\n") || "    (none)"}

📐 OOB RESOLVED FIELDS:
${oobFields.join("\n") || "  (not resolved)"}

📐 CUSTOM TENANT FIELDS under _${cfg.TENANT_ID} (${tenantProps.length} found):
${tenantProps.join("\n\n") || "  (none found inline — see fieldgroups above)"}
${debugBlock}

💡 To inspect fieldgroup fields: call get_fieldgroup with a fieldgroup altId
💡 To list all tenant fieldgroups: call list_schema_fieldgroups` }] };
    })
  );

  // ════════ TOOL 18 — list_schema_fieldgroups ══════════════════════════════════
  server.tool("list_schema_fieldgroups",
    "List all tenant fieldgroups compatible with the Offer Item class. Read-only.",
    {
      include_global: z.boolean().default(false),
      access_token:   z.string().optional(),
    },
    wrap(async ({ include_global, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const filter   = `property=meta:intendedToExtend==${encodeURIComponent(cfg.OOB_OFFER_CLASS)}`;
      const tenantRes = await apiCall(`${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups?${filter}&orderby=title`, "GET", schemaHeaders(token, cfg, "application/vnd.adobe.xed-id+json"));
      const globalRes = include_global
        ? await apiCall(`${DEFAULTS.BASE_SCHEMA_URL}/global/fieldgroups?${filter}&orderby=title`, "GET", schemaHeaders(token, cfg, "application/vnd.adobe.xed-id+json"))
        : null;

      if (!tenantRes.ok)
        return { content: [{ type: "text", text: `❌ Fieldgroup list failed (${tenantRes.status}):\n${JSON.stringify(tenantRes.body, null, 2)}` }] };

      const tenantItems = extractItems(tenantRes.body);
      const globalItems = globalRes?.ok ? extractItems(globalRes.body) : [];
      const fmt = items => items.map(fg =>
        `  • ${fg.title || "untitled"}\n    altId  : ${fg["meta:altId"]||"?"}\n    $id    : ${fg["$id"]||"?"}\n    version: ${fg.version||"?"}`
      ).join("\n\n");

      return { content: [{ type: "text", text:
`📋 FIELDGROUPS FOR OFFER ITEM CLASS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Class   : ${cfg.OOB_OFFER_CLASS}
Sandbox : ${cfg.SANDBOX_NAME}

🏢 YOUR TENANT FIELDGROUPS (${tenantItems.length}):
${tenantItems.length ? fmt(tenantItems) : "  (none — no custom fieldgroups created yet)"}

${include_global ? `🌐 ADOBE GLOBAL FIELDGROUPS (${globalItems.length}):\n${globalItems.length ? fmt(globalItems) : "  (none)"}` : "💡 Pass include_global: true to also see Adobe OOB fieldgroups."}

💡 To inspect fields inside any fieldgroup: call get_fieldgroup with its altId.` }] };
    })
  );

  // ════════ TOOL 19 — get_fieldgroup ═══════════════════════════════════════════
  server.tool("get_fieldgroup",
    "Fetch the full field definitions inside a specific fieldgroup by its altId. Read-only.",
    {
      fieldgroup_id: z.string(),
      access_token:  z.string().optional(),
    },
    wrap(async ({ fieldgroup_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups/${fieldgroup_id}`, "GET",
        schemaHeaders(token, cfg, "application/vnd.adobe.xed-full+json; version=1")
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Fieldgroup lookup failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const fg         = res.body;
      const fieldLines = [];
      const defs       = fg.definitions || {};

      for (const [, defVal] of Object.entries(defs)) {
        for (const [propKey, propVal] of Object.entries(defVal?.properties || {})) {
          if (propKey === `_${cfg.TENANT_ID}` && propVal?.properties) {
            for (const [fk, fv] of Object.entries(propVal.properties)) {
              const dep   = fv?.["meta:status"]==="deprecated" ? " ⚠️ DEPRECATED" : "";
              const type  = fv?.["meta:xdmType"] || fv?.type || "?";
              const title = fv?.title || fk;
              const desc  = fv?.description ? `\n    Desc : ${fv.description}` : "";
              const enums = fv?.["meta:enum"] ? `\n    Enum : ${Object.keys(fv["meta:enum"]).join(", ")}` : "";
              fieldLines.push(`  • _${cfg.TENANT_ID}.${fk} (${type})${dep}\n    Title: ${title}${desc}${enums}`);
            }
          } else if (propKey !== `_${cfg.TENANT_ID}`) {
            const dep  = propVal?.["meta:status"]==="deprecated" ? " ⚠️ DEPRECATED" : "";
            const type = propVal?.["meta:xdmType"] || propVal?.type || "?";
            fieldLines.push(`  • ${propKey} (${type})${dep}\n    Title: ${propVal?.title||propKey}`);
          }
        }
      }

      if (!fieldLines.length && fg.properties) {
        for (const [propKey, propVal] of Object.entries(fg.properties)) {
          if (propKey === `_${cfg.TENANT_ID}` && propVal?.properties) {
            for (const [fk, fv] of Object.entries(propVal.properties)) {
              const dep  = fv?.["meta:status"]==="deprecated" ? " ⚠️ DEPRECATED" : "";
              const type = fv?.["meta:xdmType"] || fv?.type || "?";
              fieldLines.push(`  • _${cfg.TENANT_ID}.${fk} (${type})${dep}\n    Title: ${fv?.title||fk}`);
            }
          } else {
            fieldLines.push(`  • ${propKey} (${propVal?.["meta:xdmType"]||propVal?.type||"?"})\n    Title: ${propVal?.title||propKey}`);
          }
        }
      }

      if (!fieldLines.length && fg.allOf) {
        for (const block of fg.allOf) {
          const ns = block?.properties?.[`_${cfg.TENANT_ID}`]?.properties || {};
          for (const [fk,fv] of Object.entries(ns)) {
            fieldLines.push(`  • _${cfg.TENANT_ID}.${fk} (${fv?.["meta:xdmType"]||fv?.type||"?"})\n    Title: ${fv?.title||fk}`);
          }
        }
      }

      if (!fieldLines.length) {
        return { content: [{ type: "text", text:
`📋 FIELDGROUP: ${fg.title || fieldgroup_id}
altId   : ${fg["meta:altId"] || fieldgroup_id}
Version : ${fg.version || "?"}

⚠️ Could not parse fields from standard structure.
Top-level keys   : ${Object.keys(fg).join(", ")}
Definition keys  : ${Object.keys(defs).join(", ")}
Has properties   : ${!!fg.properties}
Has allOf        : ${!!fg.allOf}
Properties keys  : ${fg.properties ? Object.keys(fg.properties).join(", ") : "(none)"}

Raw definitions:
${JSON.stringify(defs, null, 2)}` }] };
      }

      return { content: [{ type: "text", text:
`📋 FIELDGROUP: ${fg.title || "untitled"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
altId         : ${fg["meta:altId"] || fieldgroup_id}
$id           : ${fg["$id"] || "?"}
Version       : ${fg.version || "?"}
Description   : ${fg.description || "(none)"}
Definition key: ${Object.keys(defs).join(", ") || "(none)"}
Intended for  : ${(fg["meta:intendedToExtend"]||[]).join(", ") || "?"}

📐 FIELDS (${fieldLines.length} found):
${fieldLines.join("\n\n")}

💡 To add a new field: call add_schema_field with fieldgroup_id: "${fg["meta:altId"]||fieldgroup_id}"
💡 To deprecate a field: call deprecate_schema_field with fieldgroup_id: "${fg["meta:altId"]||fieldgroup_id}"` }] };
    })
  );

  // ════════ TOOL 20 — get_schema_audit_log ═════════════════════════════════════
  server.tool("get_schema_audit_log",
    "Fetch the full audit log for the decisioning schema — every change ever made, newest first. Read-only.",
    { access_token: z.string().optional() },
    wrap(async ({ access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/rpc/auditlog/${cfg.DECISIONING_SCHEMA_ALT_ID}`, "GET",
        {
          "Authorization":   `Bearer ${token}`,
          "x-api-key":        cfg.CLIENT_ID,
          "x-gw-ims-org-id":  cfg.ORG_ID,
          "x-sandbox-name":   cfg.SANDBOX_NAME,
        }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Audit log failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      const entries = Array.isArray(res.body) ? res.body : [];
      if (!entries.length)
        return { content: [{ type: "text", text: "⚠️ No audit log entries found." }] };
      const lines = entries.map((e,i) => {
        const updates = (e.updates||[]).map(u => `      ${u.action} | ${u.path||"(schema level)"} | type: ${u.xdmType||"?"}`).join("\n");
        return `${i+1}. ${e.updatedTime||"?"} — v${e.version||"?"} — by ${e.updatedUser||"?"}\n   requestId: ${e.requestId||"?"}\n${updates ? `   changes:\n${updates}` : "   (no field-level changes)"}`;
      });
      return { content: [{ type: "text", text:
`📜 SCHEMA AUDIT LOG — ${cfg.SANDBOX_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Schema  : ${cfg.DECISIONING_SCHEMA_ALT_ID}
Entries : ${entries.length}

${lines.join("\n\n")}` }] };
    })
  );

  // ════════ TOOL 21 — list_schema_descriptors ══════════════════════════════════
  server.tool("list_schema_descriptors",
    "List all descriptors on the decisioning schema — identity, deprecation, display name overrides, and relationships. Read-only.",
    { access_token: z.string().optional() },
    wrap(async ({ access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const schemaUri = encodeURIComponent(cfg.DECISIONING_SCHEMA_URI);
      const res = await apiCall(
        `${DEFAULTS.BASE_SCHEMA_URL}/tenant/descriptors?property=xdm:sourceSchema==${schemaUri}`, "GET",
        schemaHeaders(token, cfg, "application/vnd.adobe.xdm+json")
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Descriptors fetch failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      const items = extractItems(res.body);
      if (!items.length)
        return { content: [{ type: "text", text:
`ℹ️ No descriptors found on this schema.
Schema: ${cfg.DECISIONING_SCHEMA_URI}

Meaning:
  • No identity fields marked
  • No display name overrides
  • No deprecation descriptors
  • No relationship descriptors` }] };
      const grouped = {};
      for (const d of items) {
        const t = d["@type"] || "unknown";
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push(d);
      }
      const typeLabels = {
        "xdm:descriptorIdentity":        "🔑 Identity descriptors",
        "xdm:descriptorDeprecated":       "⚠️  Deprecation descriptors",
        "xdm:alternateDisplayInfo":       "🏷️  Display name overrides",
        "xdm:descriptorRelationship":     "🔗 Relationship descriptors",
        "xdm:descriptorOneToOne":         "🔗 One-to-one relationships",
        "xdm:descriptorReferenceIdentity":"🔗 Reference identity descriptors",
      };
      const sections = Object.entries(grouped).map(([type, descs]) => {
        const label = typeLabels[type] || `📌 ${type}`;
        const lines = descs.map(d => {
          const field = d["xdm:sourceProperty"] || "(schema level)";
          const extra = type === "xdm:descriptorIdentity"
            ? ` | namespace: ${d["xdm:namespace"]||"?"} | primary: ${d["xdm:isPrimary"]??"?"}`
            : type === "xdm:alternateDisplayInfo"
            ? ` | title: ${JSON.stringify(d["xdm:title"]||{})} | desc: ${JSON.stringify(d["xdm:description"]||{})}`
            : type === "xdm:descriptorRelationship"
            ? ` | dest: ${d["xdm:destinationSchema"]||"?"} → ${d["xdm:destinationProperty"]||"?"}`
            : "";
          return `    • field: ${field}${extra}\n      id: ${d["@id"]||"?"}`;
        }).join("\n");
        return `${label} (${descs.length}):\n${lines}`;
      });
      return { content: [{ type: "text", text:
`📋 SCHEMA DESCRIPTORS — ${cfg.SANDBOX_NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Schema : ${cfg.DECISIONING_SCHEMA_URI}
Total  : ${items.length} descriptor(s)

${sections.join("\n\n")}` }] };
    })
  );

  return server;
}
