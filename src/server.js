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

// Some MCP clients (Adobe Coworker at time of writing) serialize boolean tool
// arguments as strings — "true"/"false" instead of true/false. z.boolean()
// rejects those, which surfaces as a "type coercion bug" to the caller. This
// schema accepts either form and normalizes to a real boolean.
const boolish = (defaultValue = false) => z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true"  || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no"  || s === "") return false;
  }
  if (v === 1) return true;
  if (v === 0 || v == null) return false;
  return v; // let zod reject anything else with a clear error
}, z.boolean()).default(defaultValue);

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
  // Optional — when set, create_eligibility_rule and update_eligibility_rule
  // will bake this into the segmentModel so AJO doesn't prompt for a merge
  // policy each time. Not in the required-config set; missing = user gets
  // prompted in the AJO UI when they open the rule.
  MERGE_POLICY_ID:           "x-adobe-merge-policy-id",
});

const DEFAULTS = {
  OOB_OFFER_CLASS: "https://ns.adobe.com/experience/decisioning/offeritem",
  BASE_SCHEMA_URL: "https://platform.adobe.io/data/foundation/schemaregistry",
  BASE_DPS_URL:    "https://platform.adobe.io/data/core/dps",
  BASE_UPS_URL:    "https://platform.adobe.io/data/core/ups",
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

// Invalidate the specific cache entry whose token value matches. Called from
// apiCall when Adobe returns 401, so the very next mintToken() call re-mints
// fresh rather than serving the same rejected token from cache. Without this,
// a token revoked mid-TTL poisons every subsequent call until the natural
// expiresAt eventually ages it out.
export function clearTokenCacheByToken(token) {
  if (!token) return;
  for (const [k, v] of tokenCache) {
    if (v.token === token) tokenCache.delete(k);
  }
}

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
function rtcdpHeaders(token, config) {
  return {
    "Authorization":   `Bearer ${token}`,
    "x-api-key":        config.CLIENT_ID,
    "x-gw-ims-org-id":  config.ORG_ID,
    "x-sandbox-name":   config.SANDBOX_NAME,
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

// ─── HTTP CALL with safe error handling + retries ─────────────────────────────
// Adobe Platform APIs return three flavours of retriable failure at scale:
//   - 502/503/504 or network errors → transient infra hiccup
//   - 429 with Retry-After header    → rate limit, honor the header
//   - 409 "Entity update has conflict with another operation"
//                                     → DPS catalog write-lock contention when
//                                       multiple parallel POSTs hit the same
//                                       catalog. Common with bulk_create_offers.
//
// We do up to 2 retries for 409/429 (with exponential backoff) and 1 retry for
// 5xx. Anything still failing after that surfaces to the caller.
// 25s per-request abort ceiling. The 45s bulk soft-deadline only checks between
// chunks — a single in-flight request that hangs (e.g., Adobe backend stall)
// would otherwise wedge the Runtime container until its 60s hard kill. Setting
// this well below 45s means at most one request is in the timeout danger zone
// when a chunk starts, so a stalled call surfaces as a clean network_error
// instead of a container-kill "connection lost".
const REQUEST_TIMEOUT_MS = 25_000;

async function apiCall(url, method, headers, body, { retry = true } = {}) {
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  async function attempt() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      const retryAfter = res.headers.get("retry-after");
      // If Adobe rejected our token, evict it from the cache immediately so the
      // NEXT mintToken() re-mints fresh. Without this, a token that gets
      // revoked mid-TTL keeps poisoning every subsequent call until natural
      // expiry hours later.
      if (res.status === 401) {
        const auth = (opts.headers?.Authorization || opts.headers?.authorization || "").replace(/^Bearer\s+/i, "");
        if (auth) clearTokenCacheByToken(auth);
      }
      return { status: res.status, ok: res.ok, body: json, retryAfter };
    } catch (e) {
      const timedOut = e.name === "AbortError";
      return {
        status: 0,
        ok: false,
        body: {
          error:   timedOut ? "request_timeout" : "network_error",
          message: timedOut ? `Adobe backend did not respond within ${REQUEST_TIMEOUT_MS/1000}s` : e.message,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  let last = await attempt();
  if (!retry) return last;

  const backoffFor = (attemptNum, status, hdr) => {
    if (status === 429) return Math.min(10_000, Math.max(500, (parseInt(hdr, 10) || 1) * 1000));
    if (status === 409) return 300 + 500 * attemptNum + Math.floor(Math.random() * 300); // jittered
    return 400; // 5xx / network
  };

  for (let i = 1; i <= 2; i++) {
    const s = last.status;
    const isRetriable = s === 0 || s === 429 || s === 409 || s === 502 || s === 503 || s === 504;
    if (!isRetriable) break;
    // For plain transient 5xx / network, only bother with one retry
    if (i > 1 && (s === 0 || s === 502 || s === 503 || s === 504)) break;
    await new Promise(r => setTimeout(r, backoffFor(i, s, last.retryAfter)));
    last = await attempt();
    if (last.ok) break;
  }

  return last;
}

function extractItems(body) {
  return body.results || body.items || body._embedded?.items || body.data || [];
}

// Scan every selection_strategy in the sandbox and return the ones whose
// serialized JSON mentions `resourceId`. Selection strategies are the "hub"
// resource that reference collections, ranking formulas, eligibility rules,
// and placements — so this one scan powers the dependency preview for four
// of the delete_* tools. Bounded to 20 pages × 100 = 2000 strategies (plenty
// for real tenants; anything beyond is rare and the caller can still delete
// with an explicit confirmed:true if they want to override).
async function findSelectionStrategyReferences(resourceId, token, cfg) {
  if (!resourceId) return { refs: [], truncated: false, error: null };
  const PAGE_SIZE = 100, MAX_PAGES = 20;
  const refs = [];
  let url = `${DEFAULTS.BASE_DPS_URL}/selection-strategies?limit=${PAGE_SIZE}`;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await apiCall(url, "GET", dpsHeaders(token, cfg));
    if (!res.ok) return { refs, truncated, error: `(${res.status}): ${JSON.stringify(res.body).slice(0, 200)}` };
    const items = extractItems(res.body);
    for (const s of items) {
      // A substring search on the stringified strategy catches every field
      // where the ID could appear (rank.order.function, optionSelection,
      // eligibility, placement, etc.) without needing per-schema knowledge.
      if (JSON.stringify(s).includes(resourceId)) {
        refs.push({ id: s.id, name: s.name || "(unnamed)" });
      }
    }
    const next = res.body._links?.next?.href;
    if (!next || items.length === 0) break;
    if (page === MAX_PAGES - 1) truncated = true;
    url = next.startsWith("http") ? next : `${DEFAULTS.BASE_DPS_URL}${next}`;
  }
  return { refs, truncated, error: null };
}

// Compact preview line for delete_* confirmations. Renders "no references
// found" when the list is empty (useful info — tells the user it's safe),
// or the first few referring items when non-empty.
function formatDependencyPreview(resourceLabel, refs, truncated, error) {
  if (error) return `⚠️  Could not check for dependencies: ${error}`;
  if (!refs.length) return `✅ No selection strategies reference this ${resourceLabel} (safe to delete).`;
  const shown = refs.slice(0, 5);
  return `⚠️  ${refs.length} selection strategy(ies) reference this ${resourceLabel}${truncated ? " (search truncated at 2000 strategies)" : ""}:
${shown.map(r => `     • ${r.name}  (${r.id})`).join("\n")}${refs.length > 5 ? `\n     ... (${refs.length - 5} more)` : ""}

   Deleting this ${resourceLabel} will BREAK those strategies. Consider updating them first.`;
}

// Runs `fn(item)` over `items` in concurrency-limited chunks — avoids blowing
// past Vercel's 60s function timeout on large batches while staying under
// DPS rate limits. `fn` must resolve to { id, res } where res is an
// apiCall() result. Shared by every bulk_* tool.
async function runChunked(items, fn, chunkSize = 5) {
  const results = [], errors = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const settled = await Promise.all(chunk.map(fn));
    for (const { id, res } of settled) {
      if (res.ok) results.push(id);
      else        errors.push({ id, error: JSON.stringify(res.body) });
    }
  }
  return { results, errors };
}

// Paginates through a DPS list endpoint (bounded — 20 pages of 100, plenty for
// name-lookup purposes) and returns every item, for the name-resolution
// helpers below.
// Adobe DPS list endpoints use cursor pagination via _links.next, NOT offset.
// The offset query param is silently ignored — passing offset=100 returns the
// same first page as offset=0. Follow _links.next.href instead.
async function fetchAllItems(urlBase, headers) {
  const PAGE_SIZE = 100, MAX_PAGES = 50; // 50 * 100 = 5,000 items ceiling
  const all = [];
  let url = `${urlBase}&limit=${PAGE_SIZE}`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await apiCall(url, "GET", headers);
    if (!res.ok) return { items: null, error: `(${res.status}): ${JSON.stringify(res.body)}` };
    const items = extractItems(res.body);
    all.push(...items);
    // Follow the cursor Adobe hands us in _links.next.href — it's a relative
    // path from the DPS root (e.g. "/offer-items?...&start=...").
    const nextHref = res.body._links?.next?.href;
    if (!nextHref || items.length === 0) break;
    url = nextHref.startsWith("http") ? nextHref : `${DEFAULTS.BASE_DPS_URL}${nextHref}`;
  }
  return { items: all, error: null };
}

// Resolves a mixed array of offer IDs / exact offer names into pure IDs.
// Anything starting with "dps:" is treated as an ID already (no lookup);
// everything else is matched against itemName. A name matching zero or more
// than one offer fails with a consolidated error rather than guessing.
async function resolveOfferIdentifiers(identifiers, token, cfg) {
  const needsLookup = identifiers.some(x => !x.startsWith("dps:"));
  if (!needsLookup) return { ids: identifiers, error: null };

  const { items, error } = await fetchAllItems(`${DEFAULTS.BASE_DPS_URL}/offer-items?`, offerItemHeaders(token, cfg));
  if (error) return { ids: null, error: `Could not list offer items to resolve names ${error}` };

  const byName = new Map();
  for (const it of items) {
    const name = it._experience?.decisioning?.decisionitem?.itemName;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(it.id);
  }

  const errors = [];
  const resolved = identifiers.map(x => {
    if (x.startsWith("dps:")) return x;
    const matches = byName.get(x) || [];
    if (matches.length === 0) { errors.push(`No offer item found with name "${x}"`); return null; }
    if (matches.length > 1)  { errors.push(`Name "${x}" matches ${matches.length} offer items — ambiguous: ${matches.join(", ")}. Use an ID instead.`); return null; }
    return matches[0];
  });

  return errors.length ? { ids: null, error: errors.join(" | ") } : { ids: resolved, error: null };
}

// Resolves an eligibility-rule ID or exact rule name to {id, name}. Always
// validates existence (a direct GET for an already-given ID; a name match
// for a lookup) so callers get one consistent shape either way.
async function resolveEligibilityRuleIdentifier(identifier, token, cfg) {
  if (identifier.startsWith("dps:")) {
    const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-rules/${identifier}`, "GET", dpsHeaders(token, cfg));
    if (!res.ok) return { id: null, name: null, body: null, error: `Could not find eligibility rule ${identifier} (${res.status}): ${JSON.stringify(res.body)}` };
    return { id: identifier, name: res.body.name, body: res.body, error: null };
  }

  const { items, error } = await fetchAllItems(`${DEFAULTS.BASE_DPS_URL}/offer-rules?property=exdRule%3D%3Dtrue&`, dpsHeaders(token, cfg));
  if (error) return { id: null, name: null, body: null, error: `Could not list eligibility rules to resolve name ${error}` };

  const matches = items.filter(r => r.name === identifier);
  if (matches.length === 0) return { id: null, name: null, body: null, error: `No eligibility rule found with name "${identifier}"` };
  if (matches.length > 1)  return { id: null, name: null, body: null, error: `Name "${identifier}" matches ${matches.length} eligibility rules (${matches.map(m => m.id).join(", ")}) — ambiguous. Use an ID instead.` };
  // List items may be summary-only — body is left null so the caller does a final GET for the full object.
  return { id: matches[0].id, name: matches[0].name, body: null, error: null };
}

// Generic ID-or-name resolver shared by the remaining get_* tools (collection,
// ranking formula, selection strategy, placement). Tries a direct GET first
// (also doubling as existence validation and giving the caller the full body
// for free); falls back to an exact-name search across the resource's list
// endpoint, same ambiguous/missing-name error handling as the resolvers above.
async function resolveByIdOrName({ identifier, directUrl, listUrl, headers, resourceLabel }) {
  if (identifier.startsWith("dps:")) {
    const res = await apiCall(directUrl(identifier), "GET", headers);
    if (!res.ok) return { id: null, body: null, error: `Could not find ${resourceLabel} ${identifier} (${res.status}): ${JSON.stringify(res.body)}` };
    return { id: identifier, body: res.body, error: null };
  }

  const { items, error } = await fetchAllItems(listUrl, headers);
  if (error) return { id: null, body: null, error: `Could not list ${resourceLabel}s to resolve name ${error}` };

  const matches = items.filter(x => x.name === identifier);
  if (matches.length === 0) return { id: null, body: null, error: `No ${resourceLabel} found with name "${identifier}"` };
  if (matches.length > 1)  return { id: null, body: null, error: `Name "${identifier}" matches ${matches.length} ${resourceLabel}s (${matches.map(m => m.id).join(", ")}) — ambiguous. Use an ID instead.` };
  return { id: matches[0].id, body: null, error: null };
}

function resolveCollectionIdentifier(identifier, token, cfg) {
  return resolveByIdOrName({
    identifier, resourceLabel: "collection",
    directUrl: (id) => `${DEFAULTS.BASE_DPS_URL}/item-collections/${id}`,
    listUrl: `${DEFAULTS.BASE_DPS_URL}/item-collections?`,
    headers: dpsHeaders(token, cfg),
  });
}
function resolveRankingFormulaIdentifier(identifier, token, cfg) {
  return resolveByIdOrName({
    identifier, resourceLabel: "ranking formula",
    directUrl: (id) => `${DEFAULTS.BASE_DPS_URL}/ranking-formulas/${id}`,
    listUrl: `${DEFAULTS.BASE_DPS_URL}/ranking-formulas?property=exdFunction%3D%3Dtrue&`,
    headers: dpsHeaders(token, cfg),
  });
}
function resolveSelectionStrategyIdentifier(identifier, token, cfg) {
  return resolveByIdOrName({
    identifier, resourceLabel: "selection strategy",
    directUrl: (id) => `${DEFAULTS.BASE_DPS_URL}/selection-strategies/${id}`,
    listUrl: `${DEFAULTS.BASE_DPS_URL}/selection-strategies?`,
    headers: dpsHeaders(token, cfg),
  });
}
function resolvePlacementIdentifier(identifier, token, cfg) {
  return resolveByIdOrName({
    identifier, resourceLabel: "placement",
    directUrl: (id) => `${DEFAULTS.BASE_DPS_URL}/exd-placements/${id}`,
    listUrl: `${DEFAULTS.BASE_DPS_URL}/exd-placements?`,
    headers: placementHeaders(token, cfg),
  });
}

// ─── Real-Time CDP audience (segment) support ─────────────────────────────────
// Audiences are a genuinely separate resource from eligibility rules — managed
// under their own Audience tab / Unified Profile Segmentation Service, not the
// offer-rules endpoint. But the only mechanism that actually attaches
// something to an offer's itemConstraints is profileConstraintType:
// "eligibilityRule" — confirmed empirically that "audience"/"segment" as a
// profileConstraintType value are rejected identically to a garbage value.
// So "attach an audience" works by wrapping a segment-membership check in a
// real eligibility rule (auto-generated, named "Audience: <name>", reused by
// that exact name on repeat calls) and attaching THAT rule's ID exactly like
// any other decision rule.
//
// CONFIRMED PQL syntax for segment membership (found by iterating against the
// real PQL parser's error messages until it accepted a real segment ID):
//   segmentMembership["ups"]["<segment-id>"]["status"].equals("realized", false)
// Both map levels need bracket indexing (segmentMembership is
// Map[STRING => Map[STRING => OBJECT]]) — dot access on either level fails
// with a type error, and infix == fails to parse; only the method-call
// comparison form works, consistent with every other PQL string comparison
// confirmed elsewhere in this file.
function segmentMembershipPql(segmentId) {
  return `segmentMembership["ups"]["${segmentId}"]["status"].equals("realized", false)`;
}

async function fetchAllAudiences(token, cfg) {
  const PAGE_SIZE = 100, MAX_PAGES = 20;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await apiCall(`${DEFAULTS.BASE_UPS_URL}/segment/definitions?limit=${PAGE_SIZE}&start=${page}`, "GET", rtcdpHeaders(token, cfg));
    if (!res.ok) return { items: null, error: `(${res.status}): ${JSON.stringify(res.body)}` };
    const items = res.body.segments || [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return { items: all, error: null };
}

// Resolves an audience ID or exact name to {id, name}. IDs here are plain
// UPS segment UUIDs (no "dps:" prefix to sniff), so we try a direct GET first
// and fall back to a name search — works for either input without needing to
// guess the format.
async function resolveAudienceIdentifier(identifier, token, cfg) {
  const direct = await apiCall(`${DEFAULTS.BASE_UPS_URL}/segment/definitions/${identifier}`, "GET", rtcdpHeaders(token, cfg));
  if (direct.ok) return { id: identifier, name: direct.body.name, error: null };

  const { items, error } = await fetchAllAudiences(token, cfg);
  if (error) return { id: null, name: null, error: `Could not list audiences to resolve name ${error}` };

  const matches = items.filter(a => a.name === identifier);
  if (matches.length === 0) return { id: null, name: null, error: `No audience found with ID or name "${identifier}"` };
  if (matches.length > 1)  return { id: null, name: null, error: `Name "${identifier}" matches ${matches.length} audiences (${matches.map(m => m.id).join(", ")}) — ambiguous. Use an ID instead.` };
  return { id: matches[0].id, name: matches[0].name, error: null };
}

// Finds (by the deterministic "Audience: <name>" naming convention) or
// creates the eligibility rule that wraps a given audience's segment
// membership. Reused across repeat attach calls for the same audience rather
// than creating a duplicate rule each time. Only call this once the caller
// has actually confirmed the write — it creates real state (a new
// eligibility rule) when no matching one exists yet.
async function ensureAudienceEligibilityRule(audienceId, audienceName, token, cfg) {
  const ruleName = `Audience: ${audienceName}`;
  const lookup = await resolveEligibilityRuleIdentifier(ruleName, token, cfg);
  if (lookup.id) return { id: lookup.id, name: lookup.name, reused: true, error: null };
  if (lookup.error && lookup.error.includes("ambiguous")) return { id: null, name: null, reused: false, error: lookup.error };

  const pql = segmentMembershipPql(audienceId);
  const description = `Auto-generated eligibility rule for audience "${audienceName}" (segment ${audienceId}).`;
  const { segmentModel } = pqlToSegmentModel({ pql, name: ruleName, description });
  const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-rules`, "POST", dpsHeaders(token, cfg), {
    name: ruleName, description, exdRule: true,
    condition: { type: "PQL", format: "pql/text", value: pql },
    segmentModel,
  });
  if (!res.ok) return { id: null, name: null, reused: false, error: `Could not create eligibility rule for audience "${audienceName}" (${res.status}): ${JSON.stringify(res.body)}` };
  return { id: res.body.id, name: ruleName, reused: false, error: null };
}

// ─── PQL → segmentModel translator ────────────────────────────────────────────
// AJO's Segment/Rule Builder UI renders eligibility rules from `segmentModel`,
// not from the raw `condition.value` PQL string. Rules created via this API
// with only `condition` still evaluate correctly at runtime, but open as a
// blank/uneditable card in the UI's Rule Builder.
//
// This is a recursive-descent parser for boolean PQL over profile attributes
// (event-attribute PQL is explicitly out of scope — xEventAttributesContainer
// is always left empty). Confirmed against real UI-created segmentModel
// examples:
//   - single condition                        → flat profileAttributesContainer,
//                                                 logicalOperator "and", 1 item
//   - "A and B or C" (and binds tighter than or)
//                                               → top container logicalOperator
//                                                 "or", items = [nested AND
//                                                 segmentContainer{A,B}, item C]
//   - comparisonType "equals" and "notEqualTo" confirmed from real rules
//   - comparisonType "startsWith", "endsWith", "contains", "isNull",
//     "isNotNull", "doesNotContain", "doesNotStartWith", "doesNotEndWith" all
//     confirmed from a second real rule
//   - Infix operators (field != value) preserve their LITERAL symbol as
//     comparisonType (e.g. "!=", not "notEqualTo") and use a scalar value
//     matching the literal's actual type (bool/number/string), NOT an
//     array — confirmed via `personalEmail.primary != false` →
//     { comparisonType: "!=", value: false, isCaseSensitive: false }.
//     This is a real, confirmed divergence from method-call style, which
//     always array-wraps string values, e.g. `.equals("Delhi", false)` →
//     value: ["Delhi"].
//   - Empty-string arguments produce value: [] (not [""]) — confirmed via
//     `.notEqualTo("", false)` → value: [].
//
// Anything not in the CONFIRMED set below is a best-effort extrapolation —
// flagged as such in the returned warning so results can be spot-checked in
// AJO's Rule Builder rather than trusted blindly.

// String-arg method comparisons all share the same shape: field.method("val",
// caseSensitive?) → array-wrapped value, empty string collapses to [].
function stringMethodPattern(methodName, comparisonType, confirmed) {
  return {
    re: new RegExp(`^(?:profile\\.)?([\\w.]+)\\.${methodName}\\(\\s*"([^"]*)"\\s*(?:,\\s*(true|false)\\s*)?\\)$`),
    confirmed,
    build: (m) => ({ comparisonType, value: m[2] === "" ? [] : [m[2]], isCaseSensitive: m[3] === "true", field: m[1] }),
  };
}

// Parses an infix RHS literal into its native JS scalar type — string
// (unwrapped, no array), boolean, or number — matching the confirmed
// scalar-value convention for infix comparisons.
function parseInfixLiteral(raw) {
  const t = raw.trim();
  if (/^"([^"]*)"$/.test(t)) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

const PQL_COMPARISON_PATTERNS = [
  // ── String-arg method calls — CONFIRMED shape/value handling ──────────────
  stringMethodPattern("equals",            "equals",            true),
  stringMethodPattern("notEqualTo",        "notEqualTo",        true),
  stringMethodPattern("contains",          "contains",          true),
  stringMethodPattern("startsWith",        "startsWith",        true),
  stringMethodPattern("endsWith",          "endsWith",          true),
  stringMethodPattern("doesNotContain",    "doesNotContain",    true),
  stringMethodPattern("doesNotStartWith",  "doesNotStartWith",  true),
  stringMethodPattern("doesNotEndWith",    "doesNotEndWith",    true),

  // field.isNull()  /  field.isNotNull()               — CONFIRMED, no args, empty value array
  { re: /^(?:profile\.)?([\w.]+)\.isNull\(\)$/,
    confirmed: true,
    build: (m) => ({ comparisonType: "isNull", value: [], isCaseSensitive: false, field: m[1] }) },
  { re: /^(?:profile\.)?([\w.]+)\.isNotNull\(\)$/,
    confirmed: true,
    build: (m) => ({ comparisonType: "isNotNull", value: [], isCaseSensitive: false, field: m[1] }) },

  // field != literal  /  field == literal              — "!=" CONFIRMED (boolean case);
  // "==" assumed symmetric but not independently observed. Literal symbol
  // preserved as comparisonType; value is a scalar matching the literal type.
  { re: /^(?:profile\.)?([\w.]+)\s*(!=)\s*(true|false|-?[\d.]+|"[^"]*")$/,
    confirmed: true,
    build: (m) => ({ comparisonType: "!=", value: parseInfixLiteral(m[3]), isCaseSensitive: false, field: m[1] }) },
  { re: /^(?:profile\.)?([\w.]+)\s*(==)\s*(true|false|-?[\d.]+|"[^"]*")$/,
    confirmed: false,
    build: (m) => ({ comparisonType: "==", value: parseInfixLiteral(m[3]), isCaseSensitive: false, field: m[1] }) },

  // field.in(["a","b",...])                            — inferred
  { re: /^(?:profile\.)?([\w.]+)\.in\(\s*\[([^\]]*)\]\s*\)$/,
    confirmed: false,
    build: (m) => ({ comparisonType: "isAnyOf",
      value: m[2].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean),
      isCaseSensitive: false, field: m[1] }) },

  // field.greaterThan(value) / field.lessThan(value)   — inferred (method-call form)
  { re: /^(?:profile\.)?([\w.]+)\.greaterThan\(\s*(-?[\d.]+)\s*\)$/,
    confirmed: false,
    build: (m) => ({ comparisonType: "greaterThan", value: Number(m[2]), isCaseSensitive: false, field: m[1] }) },
  { re: /^(?:profile\.)?([\w.]+)\.lessThan\(\s*(-?[\d.]+)\s*\)$/,
    confirmed: false,
    build: (m) => ({ comparisonType: "lessThan", value: Number(m[2]), isCaseSensitive: false, field: m[1] }) },

  // field > value / < / >= / <=  (numeric, unquoted)   — inferred, extrapolated
  // from the confirmed "!=" pattern: literal symbol preserved, scalar value.
  { re: /^(?:profile\.)?([\w.]+)\s*(>=|<=|>|<)\s*(-?[\d.]+)$/,
    confirmed: false,
    build: (m) => ({ comparisonType: m[2], value: Number(m[3]), isCaseSensitive: false, field: m[1] }) },
];

function matchComparison(raw) {
  const trimmed = raw.trim();
  for (const p of PQL_COMPARISON_PATTERNS) {
    const m = trimmed.match(p.re);
    if (m) return { ...p.build(m), confirmed: p.confirmed, raw: trimmed };
  }
  return null;
}

// Recursive-descent parser: expr := or ; or := and (OR and)* ; and := term (AND term)* ;
// term := '(' or ')' | comparison-leaf. Whole-word "and"/"or" only count as
// operators outside quotes and outside a comparison's own argument parens, so
// values like "Simon and Garfunkel" or nested method calls don't get split.
function parsePqlBoolean(pql) {
  const s = pql;
  let i = 0;
  let hasUnclosedParen = false;

  function isWordBoundaryAt(pos) { return !/[a-zA-Z0-9_]/.test(s[pos] || ""); }
  function skipWs() { while (i < s.length && /\s/.test(s[i])) i++; }
  function peekKeyword(word) {
    skipWs();
    const slice = s.slice(i, i + word.length);
    return slice.toLowerCase() === word && isWordBoundaryAt(i + word.length) && (i === 0 || isWordBoundaryAt(i - 1));
  }

  function parseOr() {
    const children = [parseAnd()];
    while (true) {
      skipWs();
      if (peekKeyword("or")) { i += 2; children.push(parseAnd()); }
      else break;
    }
    return children.length === 1 ? children[0] : { type: "or", children };
  }

  function parseAnd() {
    const children = [parseTerm()];
    while (true) {
      skipWs();
      if (peekKeyword("and")) { i += 3; children.push(parseTerm()); }
      else break;
    }
    return children.length === 1 ? children[0] : { type: "and", children };
  }

  function parseTerm() {
    skipWs();
    if (s[i] === "(") {
      i++;
      const node = parseOr();
      skipWs();
      if (s[i] === ")") i++;
      else hasUnclosedParen = true; // reached end of input without a matching ")"
      return node;
    }
    return parseLeaf();
  }

  function parseLeaf() {
    skipWs();
    const start = i;
    let depth = 0, inQuote = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { inQuote = !inQuote; i++; continue; }
      if (inQuote) { i++; continue; }
      if (c === "(") { depth++; i++; continue; }
      if (c === ")") {
        if (depth === 0) break; // closes an outer group we're inside of
        depth--; i++; continue;
      }
      if (depth === 0 && /\s/.test(c)) {
        const save = i;
        skipWs();
        if (peekKeyword("and") || peekKeyword("or")) { i = save; break; }
        continue;
      }
      i++;
    }
    return { type: "leaf", raw: s.slice(start, i).trim() };
  }

  const ast = parseOr();
  skipWs();
  return { ast, fullyConsumed: i >= s.length && !hasUnclosedParen };
}

// Converts the AST into segment items, collecting warnings for any leaf that
// didn't match a known pattern (placeholder) or matched only an unconfirmed one.
function astToContainer(node, warnings) {
  if (node.type === "leaf") {
    const matched = matchComparison(node.raw);
    if (!matched) {
      warnings.push(`Could not parse condition "${node.raw}" — left as an empty placeholder item. Rebuild this condition manually in AJO's Rule Builder.`);
      return {
        comparisonType: "equals", component: { id: "profile.unknown", __entity__: true, type: "xk" },
        isCaseSensitive: true, isPlaceholder: true, originalLocation: [], value: [],
        itemType: "segmentRule",
      };
    }
    if (!matched.confirmed) {
      warnings.push(`Condition "${node.raw}" used comparisonType "${matched.comparisonType}", which is inferred (not yet confirmed against a real UI-created rule) — verify it renders correctly in AJO's Rule Builder.`);
    }
    return {
      comparisonType:   matched.comparisonType,
      component:        { id: `profile.${matched.field}`, __entity__: true, type: "xk" },
      isCaseSensitive:  matched.isCaseSensitive,
      isPlaceholder:    false,
      originalLocation: [],
      value:            matched.value,
      itemType:         "segmentRule",
    };
  }
  // "and" / "or" node → segmentContainer wrapping its children (each child is
  // itself either a segmentRule leaf or a nested segmentContainer).
  return {
    exclude: false,
    isCollapsed: false,
    items: node.children.map(child => astToContainer(child, warnings)),
    logicalOperator: node.type,
    itemType: "segmentContainer",
  };
}

function pqlToSegmentModel({ pql, name, description, mergePolicyId }) {
  const warnings = [];
  let profileAttributesContainer;

  try {
    const { ast, fullyConsumed } = parsePqlBoolean(pql);
    if (!fullyConsumed) {
      warnings.push(`PQL "${pql}" has trailing content the parser couldn't consume (e.g. unbalanced parentheses) — segmentModel may be incomplete. Verify in AJO's Rule Builder.`);
    }
    const rootItem = astToContainer(ast, warnings);
    // The root of profileAttributesContainer IS the top-level and/or container
    // shape. If the whole PQL was a single leaf (no and/or at all), wrap it in
    // a container with the default "and" operator, matching confirmed
    // single-condition examples.
    profileAttributesContainer = rootItem.itemType === "segmentContainer"
      ? rootItem
      : { exclude: false, isCollapsed: false, items: [rootItem], logicalOperator: "and", itemType: "segmentContainer" };
  } catch (err) {
    warnings.push(`PQL "${pql}" failed to parse (${err.message}) — segmentModel attached with an empty profileAttributesContainer. Rebuild manually in AJO's Rule Builder.`);
    profileAttributesContainer = { exclude: false, isCollapsed: false, items: [], logicalOperator: "and", itemType: "segmentContainer" };
  }

  return {
    warning: warnings.length ? warnings.join(" | ") : null,
    segmentModel: {
      lifecycleState: "published",
      expression: {
        isValid: true,
        logicalOperator: "and",
        profileAttributesContainer,
        xEventAttributesContainer: {
          exclude: false, isCollapsed: false, items: [],
          logicalOperator: "then", itemType: "eventTypeCardContainer",
        },
        itemType: "segmentDefinition",
      },
      isMissingAnsibleModel: false,
      relationalExpression: false,
      deprecated: { status: false, reason: "" },
      description: description || "",
      evaluationInfo: {
        batch: { enabled: true },
        continuous: { enabled: false },
        synchronous: { enabled: false },
      },
      payloadInfo: { schemaPath: "" },
      labels: [],
      tags: [],
      canHaveFolder: true,
      mergePolicyId: mergePolicyId || undefined,
      name,
      namespace: "ups",
    },
  };
}

// ─── Collection filter PQL → uiModel translator ───────────────────────────────
// item-collections use a different constraint format than eligibility rules:
// `uiModel` is a JSON string of {operator, value:{left, right}} targeting
// offer/decision-item fields (not profile fields), reused recursively for
// compound AND/OR via {operator:"and"|"or", value:[...]}.
//
// CONFIRMED from a real multi-condition collection built in AJO's UI:
//   - compound wrapper shape: {"operator":"or","value":[item, item, item]}
//     (this was previously an educated guess — now confirmed correct)
//   - "has"          → LIKE '%value%' style contains match
//   - "greater than" → numeric >  (NOTE: the pre-existing code in this file
//                       used "greaterThan" (camelCase) before this was ever
//                       verified against a real example — that appears to
//                       have been wrong. Corrected here.)
//   - "exists"       → IS NOT NULL (the pre-existing code used "isNotNull" —
//                       also likely wrong, corrected here)
//   - field prefixing confirmed: OOB fields → _experience.decisioning.decisionitem.<field>,
//     custom fields → _<tenant>.<field>. itemTags added to the OOB set from
//     this example (alongside itemName/itemDescription/itemPriority).
//
// The real example's operator strings are lowercase, natural-language,
// space-separated ("greater than", not "greaterThan") — a clearly different
// convention than eligibility rules' camelCase comparisonType. Every operator
// below that ISN'T one of the three confirmed above has been re-guessed to
// follow THIS now-evidenced convention, but remains unconfirmed until you
// verify one against a real example. "equals" is inherited from pre-existing
// code — plausible given the convention (it's already a simple lowercase
// word) but not independently re-confirmed here.
//
// One known gap: the real example also includes a `meta` object per item
// (field title/description/type, for the visual builder's display) which
// this translator does NOT generate — omitting it should not affect filter
// evaluation, but the collection may show generic/blank field labels if
// reopened in AJO's visual Collection Builder until re-saved via the UI.

const OOB_ITEM_FIELDS = new Set(["itemName", "itemDescription", "itemPriority", "itemTags"]);
function resolveItemFieldPath(field, tenantId) {
  const first = field.split(".")[0];
  if (first === "itemCalendarConstraints" || OOB_ITEM_FIELDS.has(first))
    return `_experience.decisioning.decisionitem.${field}`;
  if (field.startsWith("_experience.") || field.startsWith(`_${tenantId}.`)) return field;
  return `_${tenantId}.${field}`;
}

function stringUiModelPattern(methodName, operator, confirmed) {
  return {
    re: new RegExp(`^([\\w.]+)\\.${methodName}\\(\\s*"([^"]*)"\\s*\\)$`),
    confirmed,
    build: (m) => ({ operator, left: m[1], right: m[2] }),
  };
}
function numericUiModelPattern(methodName, infixOp, operator, confirmed) {
  const patterns = [{
    re: new RegExp(`^([\\w.]+)\\.${methodName}\\(\\s*(-?[\\d.]+)\\s*\\)$`),
    confirmed, build: (m) => ({ operator, left: m[1], right: Number(m[2]) }),
  }];
  if (infixOp) patterns.push({
    re: new RegExp(`^([\\w.]+)\\s*${infixOp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(-?[\\d.]+)$`),
    confirmed: false, build: (m) => ({ operator, left: m[1], right: Number(m[2]) }),
  });
  return patterns;
}

const UIMODEL_COMPARISON_PATTERNS = [
  // field.equals("value")  /  field == "value"      — inherited, plausible, not re-confirmed
  stringUiModelPattern("equals", "equals", false),
  { re: /^([\w.]+)\s*==\s*"([^"]*)"$/, confirmed: false, build: (m) => ({ operator: "equals", left: m[1], right: m[2] }) },
  // field.notEquals("value")  /  field != "value"    — inferred, guessed to match "equals" convention
  stringUiModelPattern("notEquals", "not equals", false),
  { re: /^([\w.]+)\s*!=\s*"([^"]*)"$/, confirmed: false, build: (m) => ({ operator: "not equals", left: m[1], right: m[2] }) },
  // field.contains("value")                          — CONFIRMED operator name is "has"
  stringUiModelPattern("contains", "has", true),
  // field.startsWith / endsWith("value")             — inferred, natural-language guess
  stringUiModelPattern("startsWith", "starts with", false),
  stringUiModelPattern("endsWith", "ends with", false),
  // field.greaterThan(n) / field > n                 — CONFIRMED operator string is "greater than"
  ...numericUiModelPattern("greaterThan", ">", "greater than", true),
  // field.lessThan(n) / field < n                    — inferred, symmetric guess
  ...numericUiModelPattern("lessThan", "<", "less than", false),
  // field.greaterThanOrEqual(n) / field >= n         — inferred
  ...numericUiModelPattern("greaterThanOrEqual", ">=", "greater than or equal", false),
  // field.lessThanOrEqual(n) / field <= n            — inferred
  ...numericUiModelPattern("lessThanOrEqual", "<=", "less than or equal", false),
  // field.isNull() / field.isNotNull()               — CONFIRMED "exists" for isNotNull; isNull inferred as its mirror
  { re: /^([\w.]+)\.isNull\(\)$/, confirmed: false, build: (m) => ({ operator: "does not exist", left: m[1] }) },
  { re: /^([\w.]+)\.isNotNull\(\)$/, confirmed: true, build: (m) => ({ operator: "exists", left: m[1] }) },
  // field.in(["a","b"])                              — inferred
  { re: /^([\w.]+)\.in\(\s*\[([^\]]*)\]\s*\)$/, confirmed: false,
    build: (m) => ({ operator: "is any of", left: m[1], right: m[2].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean) }) },
];

// resolveField: (bareField) => fully-qualified field path. Collections resolve
// bare names against the tenant/OOB heuristics in resolveItemFieldPath; the
// ranking-formula translator below resolves by stripping a leading "offer."
// since ranking PQL already spells out the full path.
function matchUiModelComparison(raw, resolveField) {
  const trimmed = raw.trim();
  for (const p of UIMODEL_COMPARISON_PATTERNS) {
    const m = trimmed.match(p.re);
    if (m) {
      const built = p.build(m);
      return { ...built, left: resolveField(built.left), confirmed: p.confirmed, raw: trimmed };
    }
  }
  return null;
}

function astToUiModel(node, resolveField, warnings) {
  if (node.type === "leaf") {
    const matched = matchUiModelComparison(node.raw, resolveField);
    if (!matched) {
      warnings.push(`Could not parse condition "${node.raw}" — omitted from the filter. Add it manually in AJO if needed.`);
      return null;
    }
    if (!matched.confirmed) {
      warnings.push(`Condition "${node.raw}" used operator "${matched.operator}", which is inferred (not yet confirmed against a real UI-created collection) — verify it filters correctly in AJO.`);
    }
    const value = { left: matched.left };
    if (matched.right !== undefined) value.right = matched.right;
    return { operator: matched.operator, value };
  }
  // "and" / "or" compound node — wrapper shape {operator, value:[...]} is
  // CONFIRMED (real example used "or" with 3 flat children). Mixed/nested
  // AND-inside-OR precedence for collections specifically hasn't been seen
  // yet, though the same mechanism is confirmed for eligibility rules.
  const childModels = node.children.map(c => astToUiModel(c, resolveField, warnings)).filter(Boolean);
  return { operator: node.type, value: childModels };
}

function pqlToUiModel(pql, tenantId) {
  const resolveField = (field) => resolveItemFieldPath(field, tenantId);
  const warnings = [];
  let uiModelObj;
  const trimmed = pql.trim();
  if (trimmed.toLowerCase() === "all") {
    // "all" is a documented shorthand, but it's almost never what a caller
    // actually wants when scoping a collection to a batch of recently-loaded
    // items — the constraint matches every named offer in the entire catalog,
    // not just the recent ones. Surface an explicit warning so the confirmation
    // card gives the caller a chance to course-correct before committing.
    return {
      uiModel: `{"operator":"exists","value":{"left":"_experience.decisioning.decisionitem.itemName"}}`,
      warning: `Filter "all" matches EVERY offer in this catalog — not only recently-loaded items. If you intended to scope this collection to a specific batch (e.g., items just created from a CSV), use an explicit filter such as sku.startsWith("YOUR-PREFIX"), category.equals("YOUR-CATEGORY"), or itemName.startsWith("YOUR-BATCH-NAME") before confirming.`
    };
  }
  try {
    const { ast, fullyConsumed } = parsePqlBoolean(trimmed);
    if (!fullyConsumed) warnings.push(`Filter expression "${pql}" has unparsed trailing content — check for unbalanced parentheses.`);
    uiModelObj = astToUiModel(ast, resolveField, warnings);
    if (!uiModelObj) {
      uiModelObj = { operator: "exists", value: { left: "_experience.decisioning.decisionitem.itemName" } };
      warnings.push(`Filter expression "${pql}" could not be parsed at all — defaulted to "all offers". Please review.`);
    }
  } catch (err) {
    uiModelObj = { operator: "exists", value: { left: "_experience.decisioning.decisionitem.itemName" } };
    warnings.push(`Filter expression "${pql}" failed to parse (${err.message}) — defaulted to "all offers".`);
  }
  return { uiModel: JSON.stringify(uiModelObj), warning: warnings.length ? warnings.join(" | ") : null };
}

// ─── Ranking formula PQL → uiModel translator ─────────────────────────────────
// AJO's visual Ranking Builder renders a ranking formula from `uiModel`, not
// from the raw `expression.value` PQL string alone — same gap as the
// eligibility-rule segmentModel and collection uiModel above. Ranking formulas
// created via this API with only `expression` still evaluate correctly at
// runtime, but open blank/manual-entry in the visual builder.
//
// CONFIRMED shape, from a real UI-created ranking formula:
//   if (offer._experience.decisioning.decisionitem.itemPriority > 1,  offer._experience.decisioning.decisionitem.itemPriority*5,  offer._experience.decisioning.decisionitem.itemPriority)
//   → {"criteria":[{"id":"0","index":0,
//        "assignment":" offer._experience.decisioning.decisionitem.itemPriority*5",
//        "metadata":{"closed":false},
//        "expression":{"operator":"greater than","value":{"left":"_experience.decisioning.decisionitem.itemPriority","right":1,"meta":{}}}}],
//      "finalExpression":" offer._experience.decisioning.decisionitem.itemPriority"}
//
// So the uiModel represents a single if/else-if/.../else chain: each `if(...)`
// becomes one criteria row (condition + the value assigned when it's true),
// and the innermost non-`if` expression becomes `finalExpression` (the
// fallback/default). The condition reuses the exact same operator vocabulary
// and {left,right} shape as the collection uiModel above (confirmed operator
// here: "greater than", matching the collection translator's confirmed
// mapping) — just with an added `meta: {}` per-condition, and fields resolved
// by stripping ranking PQL's explicit "offer." prefix rather than the tenant
// heuristics collections need (ranking PQL always spells out the full path,
// e.g. `offer._experience.decisioning.decisionitem.itemPriority`).
//
// This only handles a straight-line if/else chain, matching the one confirmed
// real example. A ranking PQL that isn't of that shape (e.g. an arithmetic
// combination of multiple independent `if(...)` calls, which the AJO visual
// builder itself can't represent as a single set of ordered criteria either)
// gets no uiModel — the formula still works via its PQL expression, it just
// won't open in the visual builder.

function stripOfferPrefix(field) {
  return field.replace(/^offer\./i, "");
}

// Splits a PQL call's argument list on top-level commas (respecting nested
// parens and quoted strings), and finds an opening paren's matching close —
// shared helpers for locating a bare `if(cond, then, else)` wrapper.
function splitTopLevelArgs(s) {
  const args = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') i++; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { args.push(s.slice(start, i)); start = i + 1; }
  }
  args.push(s.slice(start));
  return args;
}
function findMatchingParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') i++; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Returns {condition, thenExpr, elseExpr} only if the WHOLE string is exactly
// one bare `if(...)` call with 3 top-level args — not e.g. `if(...) + if(...)`,
// which has trailing content after the first call's matching close paren.
function matchIfCall(pql) {
  const trimmed = pql.trim();
  const head = trimmed.match(/^if\s*\(/i);
  if (!head) return null;
  const openIdx = head[0].length - 1;
  const closeIdx = findMatchingParen(trimmed, openIdx);
  if (closeIdx === -1 || closeIdx !== trimmed.length - 1) return null;
  const args = splitTopLevelArgs(trimmed.slice(openIdx + 1, closeIdx));
  if (args.length !== 3) return null;
  return { condition: args[0].trim(), thenExpr: args[1], elseExpr: args[2] };
}

// AJO's own ranking-builder-generated uiModel normalizes each assignment/
// finalExpression to exactly one leading space regardless of how the PQL text
// was spaced around the comma — confirmed against a real example where the
// source PQL had 2 spaces after each comma but the uiModel had exactly 1.
function normalizeExprText(s) {
  return " " + s.trim();
}

function pqlToRankingUiModel(pql) {
  const warnings = [];
  const criteria = [];
  let current = pql;

  while (true) {
    const call = matchIfCall(current);
    if (!call) break;
    const matched = matchUiModelComparison(call.condition, stripOfferPrefix);
    if (!matched) {
      return { uiModel: null, warning:
        `Ranking condition "${call.condition}" could not be parsed — no uiModel generated. The formula still works via its PQL expression, but won't render in AJO's visual Ranking Builder.` };
    }
    if (!matched.confirmed) {
      warnings.push(`Ranking condition "${call.condition}" used operator "${matched.operator}", which is inferred (not yet confirmed against a real UI-created ranking formula) — verify it renders correctly in AJO.`);
    }
    const value = { left: matched.left };
    if (matched.right !== undefined) value.right = matched.right;
    value.meta = {};
    criteria.push({
      id: String(criteria.length),
      index: criteria.length,
      assignment: normalizeExprText(call.thenExpr),
      metadata: { closed: false },
      expression: { operator: matched.operator, value },
    });
    current = call.elseExpr;
  }

  if (!criteria.length) {
    return { uiModel: null, warning:
      `Ranking PQL "${pql}" is not a simple if(condition, then, else) expression — no uiModel generated. Compound formulas (e.g. multiple independent if(...) calls combined with +/-) aren't representable as a single set of ordered criteria; the formula still works via its PQL expression.` };
  }

  return {
    uiModel: JSON.stringify({ criteria, finalExpression: normalizeExprText(current) }),
    warning: warnings.length ? warnings.join(" | ") : null,
  };
}

// ─── CONFIRMATION + CSV HELPERS ───────────────────────────────────────────────
// Confirmation gate for every write/delete tool. Two paths:
//
// 1. PREFERRED — MCP elicitation (server.server.elicitInput). This is a real
//    protocol-level pause: the client MUST render a form and return a distinct
//    user action (accept/decline/cancel). A calling agent cannot fabricate
//    "accept" on its own the way it could set a `confirmed: true` argument —
//    it has to actually get that value back from the client after the human
//    interacts with the form. This is what prevents an orchestrating agent
//    from silently re-invoking a write tool right after collecting an
//    unrelated missing argument (e.g. treating "here's the name" as if it
//    were also "yes, create it").
//
// 2. FALLBACK — legacy text preview + confirmed:true. Used only when the
//    connected client doesn't declare the elicitation capability (some stdio
//    hosts). Less safe — relies on the calling agent actually surfacing the
//    preview text to the human before re-calling — but keeps the tool usable
//    everywhere.
async function needsConfirmation(server, confirmed, preview) {
  const caps = server?.server?.getClientCapabilities?.();
  if (caps?.elicitation) {
    try {
      const result = await server.server.elicitInput({
        message:
`${preview}

Confirm to proceed. Declining or cancelling makes no changes.`,
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: {
              type: "boolean",
              title: "Confirm this write",
              description: "Set to true to proceed, false to cancel. No changes are made until you confirm.",
            },
          },
          required: ["confirmed"],
        },
      });
      if (result?.action === "accept" && result?.content?.confirmed === true) return null;
      return { content: [{ type: "text", text: "❌ Cancelled — this action was not confirmed by the user." }] };
    } catch (err) {
      // Client declared elicitation but the request itself failed — don't
      // hard-fail the tool, just fall through to the legacy pattern below.
    }
  }

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
  // Papa never throws on bad CSV — it collects errors on .errors and returns
  // whatever partial rows it managed to reconstruct. Surface those errors so
  // the caller can't silently create offers from garbage rows (e.g. a stray
  // quote that turns "name,priority,category" into one merged column).
  const fatal = (result.errors || []).filter(e => e.type === "Delimiter" || e.type === "Quotes" || e.code === "MissingQuotes" || e.code === "UndetectableDelimiter");
  if (fatal.length) {
    const preview = fatal.slice(0, 3).map(e => `  • row ${e.row ?? "?"}: ${e.message}`).join("\n");
    throw new Error(`Malformed CSV — ${fatal.length} parse error(s):\n${preview}${fatal.length > 3 ? `\n  ... (${fatal.length - 3} more)` : ""}`);
  }
  return { columns: result.meta.fields || [], rows: result.data };
}

// Accepts a bare JSON array of offer objects, or {"offers": [...]}. Produces
// the same {columns, rows} shape parseCSV does, so downstream offer-building
// logic (bulk_create_offers) doesn't need to know which format was used.
// Unlike CSV, values keep their native JSON type (number/boolean/string) —
// the existing column-processing logic below already tolerates either.
function parseJSONRows(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); }
  catch (e) { throw new Error(`Invalid JSON in json_text: ${e.message}`); }

  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.offers) ? data.offers
    : null;
  if (!rows) throw new Error(`json_text must be a JSON array of offer objects, or {"offers": [...]}`);

  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  return { columns, rows };
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
      confirmed:       boolish().describe("Set to true to execute. Leave false to preview only."),
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

      const check = await needsConfirmation(server, confirmed,
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
    `Bulk-create ExD offer items from CSV rows or a JSON array of offer objects. Each row/object becomes one offer. Provide exactly one of csv_text or json_text. Optional per-row eligibility_rule / audience columns restrict that offer's eligibility (at most one of the two per row) — same three-way choice (none / decision rule / audience) as attach_offer_eligibility_rule. Requires confirmed: true to execute — previews payloads first. Use dry_run: true to inspect full JSON payloads. Supports large CSVs (100+ rows) via offset/limit pagination: each call processes up to ~40 offers within Adobe I/O Runtime's 60s function cap, then returns a "call again with offset:X" hint. LLMs should chain calls automatically for big batches.`,
    {
      csv_text:         z.string().optional().describe(`Full CSV text (header row + data rows). Provide this OR json_text, not both. Optional columns "eligibility_rule" and "audience" (ID or exact name; at most one per row) attach offer-level eligibility.`),
      json_text:        z.string().optional().describe(`JSON text — either a bare array of offer objects, or {"offers": [...]}. Each object's keys act like CSV column headers (e.g. [{"name":"Summer Kit","category":"Skincare","priority":1,"audience":"DOI Email Targets"}]). Provide this OR csv_text, not both.`),
      lifecycle_status: z.enum(["draft","live","archived"]).default("draft"),
      dry_run:          boolish().describe("Returns full JSON payloads without calling the API. eligibility_rule/audience columns are shown unresolved (no lookups performed) since dry_run never makes API calls."),
      confirmed:        boolish().describe("Set to true to execute the write. Leave false to preview."),
      chunk_size:       z.number().int().min(1).max(20).default(5).describe("How many offers to POST in parallel per chunk. Default 5. Larger = faster on big CSVs but risks 429 rate-limits and pushes into Adobe's 60s function cap when the sandbox has heavy XDM schema validation."),
      offset:           z.number().int().min(0).default(0).describe("Skip this many CSV rows before processing. Use for pagination on big CSVs."),
      limit:            z.number().int().min(1).max(200).default(25).describe("Process at most this many rows in this call. Default 25 — chosen so the soft 45s deadline finishes well below Adobe's 60s function cap even when the sandbox schema forces per-item validation. Set higher only if you know your CSV is small and validation is cheap."),
      access_token:     z.string().optional().describe("Bearer token — optional, server will auto-mint if missing"),
    },
    wrap(async ({ csv_text, json_text, lifecycle_status, dry_run, confirmed, chunk_size, offset, limit, access_token }) => {
      if (!csv_text && !json_text) throw new Error("Provide either csv_text or json_text.");
      if (csv_text && json_text) throw new Error("Provide only one of csv_text or json_text, not both.");

      // Validate config up front so dry_run users get a clear error too.
      const { cfg, token } = dry_run && !confirmed
        ? { cfg: { ...config, ...(describeMissingConfig(config).length ? {} : {}) }, token: null }
        : await requireApiConfig({ access_token });

      const { columns, rows: allRows } = csv_text ? parseCSV(csv_text) : parseJSONRows(json_text);
      if (!allRows.length)
        throw new Error(`Empty payload — ${csv_text ? "csv_text" : "json_text"} contained no rows. Provide at least one offer.`);
      const totalRows = allRows.length;
      const startIdx  = Math.min(offset, totalRows);
      const endIdx    = Math.min(offset + limit, totalRows);
      const rows      = allRows.slice(startIdx, endIdx);
      const windowLabel = `rows ${startIdx + 1}-${endIdx} of ${totalRows}`;

      const colLower  = col => col.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const colMap    = {};
      for (const c of columns) colMap[colLower(c)] = c;
      const findCol   = keys => { const k = keys.find(k => colMap[k]); return k ? colMap[k] : null; };
      const { startDate: defStart, endDate: defEnd } = defaultDateRange();

      const nameCol  = findCol(["name","offer_name","title","item_name"]);
      const descCol  = findCol(["description","desc","summary"]);
      const prioCol  = findCol(["priority","rank","item_priority"]);
      const startCol = findCol(["start_date","startdate","start","valid_from"]);
      const endCol   = findCol(["end_date","enddate","expiry","expiry_date","valid_to"]);
      const eligCol  = findCol(["eligibility_rule","decision_rule","eligibilityrule"]);
      const audCol   = findCol(["audience","audience_name"]);

      const resolutionErrors = [];
      const payloads = [];
      for (let i = 0; i < rows.length; i++) {
        const row       = rows[i];
        const itemName  = nameCol  ? row[nameCol]              : `Offer ${i+1}`;
        const itemDesc  = descCol  ? row[descCol]              : "";
        const itemPrio  = prioCol  ? parseInt(row[prioCol])||1 : 1;
        const startIso  = (startCol && toIsoDate(row[startCol])) || defStart;
        const endIso    = (endCol   && toIsoDate(row[endCol]))   || defEnd;
        const eligRaw   = eligCol ? row[eligCol] : undefined;
        const audRaw    = audCol  ? row[audCol]  : undefined;
        const oobKeys   = new Set([colLower(nameCol||""),colLower(descCol||""),colLower(prioCol||""),colLower(startCol||""),colLower(endCol||""),colLower(eligCol||""),colLower(audCol||""),"id"]);
        const custom    = {};
        for (const col of columns) {
          const key = colLower(col);
          if (!oobKeys.has(key) && row[col] !== undefined && row[col] !== "") {
            const n = parseFloat(row[col]);
            custom[key] = !isNaN(n) && /^-?\d+(\.\d+)?$/.test(String(row[col]).trim()) ? n : row[col];
          }
        }

        let itemConstraints = { profileConstraintType: "none" };
        let pendingAudienceName = null;
        const hasElig = eligRaw !== undefined && eligRaw !== "";
        const hasAud  = audRaw  !== undefined && audRaw  !== "";

        if (hasElig && hasAud) {
          resolutionErrors.push(`Row ${i+1} ("${itemName}"): specifies both eligibility_rule and audience — provide at most one.`);
        } else if (hasElig) {
          if (dry_run) {
            itemConstraints = { profileConstraintType: "eligibilityRule", eligibilityRule: `<unresolved: "${eligRaw}">` };
          } else {
            const ruleResolve = await resolveEligibilityRuleIdentifier(String(eligRaw), token, cfg);
            if (ruleResolve.error) resolutionErrors.push(`Row ${i+1} ("${itemName}"): eligibility_rule "${eligRaw}" — ${ruleResolve.error}`);
            else itemConstraints = { profileConstraintType: "eligibilityRule", eligibilityRule: ruleResolve.id };
          }
        } else if (hasAud) {
          if (dry_run) {
            itemConstraints = { profileConstraintType: "eligibilityRule", eligibilityRule: `<unresolved audience: "${audRaw}">` };
          } else {
            const audienceResolve = await resolveAudienceIdentifier(String(audRaw), token, cfg);
            if (audienceResolve.error) resolutionErrors.push(`Row ${i+1} ("${itemName}"): audience "${audRaw}" — ${audienceResolve.error}`);
            else pendingAudienceName = audienceResolve.name;
          }
        }

        payloads.push({
          name: itemName,
          pendingAudienceName,
          payload: {
            _experience: {
              decisioning: {
                offeritem:    { lifecycleStatus: lifecycle_status },
                decisionitem: {
                  itemCalendarConstraints: { startDate: startIso, endDate: endIso },
                  itemCatalogID:   cfg.ITEM_CATALOG_ID,
                  itemConstraints,
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

      if (resolutionErrors.length)
        return { content: [{ type: "text", text: `❌ Could not resolve eligibility_rule/audience for ${resolutionErrors.length} row(s):\n${resolutionErrors.map(e => `  • ${e}`).join("\n")}` }] };

      if (dry_run) {
        const previewPayloads = payloads.slice(0, Math.min(10, payloads.length));
        const truncated = payloads.length > previewPayloads.length;
        return { content: [{ type: "text", text:
`🔍 DRY RUN — ${payloads.length} offers would be created (window: ${windowLabel}, status: ${lifecycle_status}):
${previewPayloads.map((p,i) => `Row ${startIdx + i + 1}: "${p.name}"\n${JSON.stringify(p.payload, null, 2)}`).join("\n\n")}
${truncated ? `\n... (${payloads.length - previewPayloads.length} more rows in this window not shown)` : ""}

Call again with dry_run: false and confirmed: true to execute.` }] };
      }

      const eligCount = payloads.filter(p => p.payload._experience.decisioning.decisionitem.itemConstraints.profileConstraintType === "eligibilityRule" && !p.pendingAudienceName).length;
      const audCount  = payloads.filter(p => p.pendingAudienceName).length;
      const preview = `OFFERS TO CREATE: ${payloads.length} (window: ${windowLabel})
Status   : ${lifecycle_status}
Sandbox  : ${cfg.SANDBOX_NAME}
Catalog  : ${cfg.ITEM_CATALOG_ID}
${eligCount ? `Eligibility rule attached: ${eligCount} offer(s)\n` : ""}${audCount ? `Audience attached: ${audCount} offer(s) (eligibility rule created/reused per distinct audience)\n` : ""}
OFFER NAMES:
${payloads.slice(0, 10).map((p,i) => `  ${startIdx + i + 1}. ${p.name}`).join("\n")}${payloads.length > 10 ? `\n  ... (${payloads.length - 10} more)` : ""}

This will POST ${payloads.length} requests to /offer-items.${endIdx < totalRows ? `\n\n⚠️ CSV has ${totalRows} rows but only ${limit} will be processed this call. After confirming, you'll get a "call again with offset:${endIdx}" hint to continue.` : ""}`;
      const check = await needsConfirmation(server, confirmed, preview);
      if (check) return check;

      // Audience attachment is deferred until after confirmation — materializing
      // (creating/reusing) the wrapper eligibility rule is a real write, so it
      // must not happen during preview. One rule per distinct audience, shared
      // across every row that references it.
      const audienceNames = [...new Set(payloads.filter(p => p.pendingAudienceName).map(p => p.pendingAudienceName))];
      if (audienceNames.length) {
        const ruleIdByAudienceName = new Map();
        for (const name of audienceNames) {
          const audienceResolve = await resolveAudienceIdentifier(name, token, cfg);
          if (audienceResolve.error)
            return { content: [{ type: "text", text: `❌ Could not re-resolve audience "${name}": ${audienceResolve.error}` }] };
          const ensured = await ensureAudienceEligibilityRule(audienceResolve.id, audienceResolve.name, token, cfg);
          if (ensured.error)
            return { content: [{ type: "text", text: `❌ Could not prepare eligibility rule for audience "${name}": ${ensured.error}` }] };
          ruleIdByAudienceName.set(name, ensured.id);
        }
        for (const p of payloads) {
          if (p.pendingAudienceName) {
            p.payload._experience.decisioning.decisionitem.itemConstraints = {
              profileConstraintType: "eligibilityRule", eligibilityRule: ruleIdByAudienceName.get(p.pendingAudienceName),
            };
          }
        }
      }

      // Run in chunks; enforce a soft deadline (55s) so we return partial
      // results gracefully instead of getting killed at Runtime's 60s cap.
      // 409 catalog write-lock conflicts are auto-retried by apiCall.
      // 15s buffer below Runtime's 60s hard cap: leaves room for the current
      // chunk's in-flight POSTs (each can take ~10s under heavy XDM validation
      // + 409 catalog-conflict jittered retries) to finish before container kill.
      const SOFT_DEADLINE_MS = 45_000;
      const t0 = Date.now();
      const results = [], errors = [];
      let stopped = false;
      for (let i = 0; i < payloads.length; i += chunk_size) {
        if (Date.now() - t0 > SOFT_DEADLINE_MS) { stopped = true; break; }
        const chunk = payloads.slice(i, i + chunk_size);
        const settled = await Promise.all(chunk.map(p =>
          apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items`, "POST", offerItemHeaders(token, cfg), p.payload)
            .then(res => ({ p, res }))
        ));
        for (const { p, res } of settled) {
          if (res.ok) results.push({ name: p.name, id: res.body.id });
          else        errors.push({ name: p.name, error: JSON.stringify(res.body) });
        }
      }

      const processed  = results.length + errors.length;
      const nextOffset = startIdx + processed;
      const hasMore    = nextOffset < totalRows;
      const wallSecs   = ((Date.now() - t0) / 1000).toFixed(1);

      const showResults = results.length <= 20
        ? results.map(r => `  ✅ "${r.name}" → ${r.id}`).join("\n")
        : results.slice(0, 10).map(r => `  ✅ "${r.name}" → ${r.id}`).join("\n") +
          `\n  ... (${results.length - 20} more) ...\n` +
          results.slice(-10).map(r => `  ✅ "${r.name}" → ${r.id}`).join("\n");

      return { content: [{ type: "text", text:
`📦 BULK OFFER CREATION ${stopped ? "PARTIAL (soft time budget reached)" : "COMPLETE"}
Window   : ${windowLabel}
Processed: ${processed} in ${wallSecs}s   ✅ ${results.length} created   ❌ ${errors.length} failed
${showResults}
${errors.length ? `\nErrors:\n${errors.slice(0, 5).map(e => `  ❌ "${e.name}" → ${e.error.slice(0, 200)}`).join("\n")}${errors.length > 5 ? `\n  ... (${errors.length - 5} more errors)` : ""}` : ""}

${hasMore
  ? `⏭️  ${totalRows - nextOffset} rows remaining. Call bulk_create_offers again with:\n     offset: ${nextOffset}  (and same csv_text or json_text, confirmed: true)\n`
  : `✅ All ${totalRows} rows processed. Say "create collections" to group these offers.`}` }] };
    })
  );

  // ════════ TOOL 4 — create_collection ═════════════════════════════════════════
  server.tool("create_collection",
    "Create an offer item collection with a filter constraint. Supports multiple operators (equals, contains, greater/less than, exists, in, etc.) and multi-condition filters combined with and/or. Requires confirmed: true to execute.",
    {
      name:              z.string().describe("Collection display name"),
      description:       z.string().default(""),
      filter_expression: z.string().describe(`Filter as a PQL-like expression that will be evaluated against every offer in the catalog (not just recently-created ones). To scope a collection to a batch of items you just loaded, use a unique attribute those items share — SKU prefix, category, tag, or itemName pattern. Only use "all" when you genuinely want every offer in the catalog. Examples: 'sku.startsWith("SKR-2026-")' (recommended for CSV-loaded batches), 'category.equals("Skincare")', 'itemPriority.greaterThan(3)', 'category.contains("Skin") or itemPriority.greaterThan(3) or itemTags.isNotNull()'. Field names without a prefix are resolved automatically: itemName/itemDescription/itemPriority/itemTags/itemCalendarConstraints → OOB decision-item fields, anything else → tenant custom fields.`),
      confirmed:         boolish().describe("Set to true to execute the write."),
      access_token:      z.string().optional(),
    },
    wrap(async ({ name, description, filter_expression, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const { uiModel, warning } = pqlToUiModel(filter_expression, cfg.TENANT_ID);

      const check = await needsConfirmation(server, confirmed,
`COLLECTION TO CREATE:
  Name       : ${name}
  Description: ${description || "(none)"}
  Filter     : ${filter_expression}
  Catalog    : ${cfg.ITEM_CATALOG_ID}
  Sandbox    : ${cfg.SANDBOX_NAME}
${warning ? `\n⚠️  ${warning}\n` : ""}
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
Filter : ${filter_expression}${warning ? `\n⚠️  ${warning}` : ""}
💡 Save this ID: ${res.body.id}` }] };
    })
  );

  // ════════ TOOL 5 — create_eligibility_rule ═══════════════════════════════════
  server.tool("create_eligibility_rule",
    "Create a PQL eligibility rule for Experience Decisioning. Also builds and attaches a segmentModel so the rule opens correctly in AJO's Rule Builder UI (not just via API). Requires confirmed: true to execute.",
    {
      name:            z.string().describe("Rule display name"),
      description:     z.string().default(""),
      pql_expression:  z.string().describe("PQL expression e.g. profile.loyaltyTier.in([\"gold\",\"platinum\"]) or true for all visitors"),
      merge_policy_id: z.string().optional().describe("Merge policy ID for the segmentModel. Falls back to MERGE_POLICY_ID config/header if omitted."),
      confirmed:       boolish(),
      access_token:    z.string().optional(),
    },
    wrap(async ({ name, description, pql_expression, merge_policy_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const mergePolicyId = merge_policy_id || cfg.MERGE_POLICY_ID;
      const { segmentModel, warning } = pqlToSegmentModel({ pql: pql_expression, name, description, mergePolicyId });

      const check = await needsConfirmation(server, confirmed,
`ELIGIBILITY RULE TO CREATE:
  Name    : ${name}
  PQL     : ${pql_expression}
  Sandbox : ${cfg.SANDBOX_NAME}

A matching segmentModel will also be included so this rule opens correctly in AJO's Rule Builder UI (mergePolicyId: ${mergePolicyId || "none set — UI may prompt for one"}).
${warning ? `\n⚠️  ${warning}\n` : ""}
This will POST to /offer-rules.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-rules`, "POST",
        dpsHeaders(token, cfg),
        { name, description, exdRule: true,
          condition: { type: "PQL", format: "pql/text", value: pql_expression },
          segmentModel }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Rule creation failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Eligibility rule created
Name : ${name}
ID   : ${res.body.id}
PQL  : ${pql_expression}
segmentModel attached: yes${warning ? ` (⚠️  ${warning})` : ""}
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
      confirmed:         boolish(),
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

      const { uiModel, warning } = pqlToRankingUiModel(pql);

      const check = await needsConfirmation(server, confirmed,
`RANKING FORMULA TO CREATE:
  Name    : ${name}
  Type    : ${formula_type}
  PQL     : ${pql}
  Sandbox : ${cfg.SANDBOX_NAME}

uiModel : ${uiModel ? "will be attached so this formula opens correctly in AJO's visual Ranking Builder" : "not generated — formula will still work via PQL, but may open blank/manual-entry in AJO's visual Ranking Builder"}
${warning ? `\n⚠️  ${warning}\n` : ""}
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
          ...(uiModel ? { uiModel } : {}),
        }
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Ranking formula failed (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };
      return { content: [{ type: "text", text:
`✅ Ranking formula created
Name : ${name}
ID   : ${res.body.id}
PQL  : ${pql}
uiModel attached: ${uiModel ? "yes" : "no"}${warning ? ` (⚠️  ${warning})` : ""}
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
      confirmed:           boolish(),
      access_token:        z.string().optional(),
    },
    wrap(async ({ name, description, collection_id, eligibility_rule_id, ranking_formula_id, priority, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = await needsConfirmation(server, confirmed,
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
            ? { priority, order:{ orderEvaluationType:"scoringFunction", function:ranking_formula_id } }
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
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ name, description, channel, status, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = await needsConfirmation(server, confirmed,
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
    "Look up a single offer item by its DPS ID or exact offer name. Read-only.",
    {
      offer_id:     z.string().describe("Offer item ID or exact offer name. A name matching more than one offer fails with an error listing the matches."),
      access_token: z.string().optional(),
    },
    wrap(async ({ offer_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveOfferIdentifiers([offer_id], token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items/${resolve.ids[0]}`, "GET", offerItemHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 10 — list_offer_items ═════════════════════════════════════════
  server.tool("list_offer_items",
    "List offer items in the ExD catalog. Read-only. Adobe DPS uses cursor pagination — pass `cursor` from the previous response to get the next page. `offset` is accepted only for backward compatibility and is silently ignored.",
    {
      limit:        z.number().default(20),
      cursor:       z.string().optional().describe("Opaque next-page token from a previous response (its Next cursor line). Omit for the first page."),
      offset:       z.number().optional().describe("Deprecated: Adobe DPS ignores this. Use cursor instead."),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const url = cursor
        ? (cursor.startsWith("http") ? cursor : `${DEFAULTS.BASE_DPS_URL}${cursor}`)
        : `${DEFAULTS.BASE_DPS_URL}/offer-items?limit=${limit}`;
      const res = await apiCall(url, "GET", offerItemHeaders(token, cfg));
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      const nextHref = res.body._links?.next?.href;
      if (!items.length)
        return { content: [{ type: "text", text:
`⚠️ 0 items returned.
Total reported by API : ${res.body.total ?? res.body.count ?? "unknown"}
Raw response          : ${JSON.stringify(res.body, null, 2)}` }] };

      return { content: [{ type: "text", text:
`📋 Offer items (${items.length} on this page):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(i => {
  const d = i._experience?.decisioning?.decisionitem;
  const s = i._experience?.decisioning?.offeritem?.lifecycleStatus || "-";
  return `  • ${d?.itemName||"unnamed"} | Priority: ${d?.itemPriority??"-"} | Status: ${s} | ID: ${i.id||"?"}`;
}).join("\n")}
${nextHref ? `\n⏭️  More pages available. Call list_offer_items again with:\n     cursor: "${nextHref}"` : `\n✅ End of results — no more pages.`}` }] };
    })
  );

  // ════════ TOOL 11 — update_offer_item ════════════════════════════════════════
  server.tool("update_offer_item",
    "Update fields on an existing offer item using JSON Patch operations. Requires confirmed: true to execute.",
    {
      offer_id:     z.string().describe("Offer item ID or exact offer name."),
      patches:      z.array(z.object({
        op:    z.enum(["replace","add","remove"]),
        path:  z.string(),
        value: z.any().optional(),
      })),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ offer_id, patches, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const offerResolve = await resolveOfferIdentifiers([offer_id], token, cfg);
      if (offerResolve.error) return { content: [{ type: "text", text: `❌ ${offerResolve.error}` }] };
      const resolvedId = offerResolve.ids[0];

      const check = await needsConfirmation(server, confirmed,
`OFFER ITEM TO UPDATE:
  Offer ID : ${resolvedId}${offer_id !== resolvedId ? ` (resolved from "${offer_id}")` : ""}
  Sandbox  : ${cfg.SANDBOX_NAME}

PATCHES TO APPLY:
${patches.map(p => `  ${p.op} ${p.path}${p.value !== undefined ? ` = ${JSON.stringify(p.value)}` : ""}`).join("\n")}

This will PATCH /offer-items/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-items/${resolvedId}`, "PATCH",
        offerItemHeaders(token, cfg), patches
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Offer ${resolvedId} updated successfully`
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
      confirmed:         boolish(),
      access_token:      z.string().optional(),
    },
    wrap(async ({ fieldgroup_id, field_name, field_title, field_description, field_type, definition_key, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const xdmTypeMap = { string:"string", integer:"int", number:"double", boolean:"boolean" };

      const check = await needsConfirmation(server, confirmed,
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
      confirmed:      boolish(),
      access_token:   z.string().optional(),
    },
    wrap(async ({ fieldgroup_id, field_name, definition_key, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const path = `/definitions/${definition_key}/properties/_${cfg.TENANT_ID}/properties/${field_name}/meta:status`;

      const check = await needsConfirmation(server, confirmed,
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
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ field_path, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const check = await needsConfirmation(server, confirmed,
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
      confirmed:     boolish(),
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

      const check = await needsConfirmation(server, confirmed,
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
      include_deprecated: boolish(),
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
    "List all tenant fieldgroups compatible with the Offer Item class. Read-only. Schema Registry uses cursor pagination — pass `cursor` from a previous response to advance. Tenants with more than ~50 fieldgroups will need to chain calls.",
    {
      include_global: boolish(),
      limit:          z.number().int().min(1).max(500).default(100).describe("Page size. Default 100, max 500."),
      cursor:         z.string().optional().describe("Opaque next-page token from a previous response's tenantNextCursor. Applies to the tenant list only."),
      access_token:   z.string().optional(),
    },
    wrap(async ({ include_global, limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const filter    = `property=meta:intendedToExtend==${encodeURIComponent(cfg.OOB_OFFER_CLASS)}`;
      // Schema Registry pagination uses ?start=<orderby-value>. When we get a
      // cursor back, it's either a full URL (DPS-style, unusual here) or the
      // scalar "start" value from _page.next. Build the right URL for either.
      const tenantUrl = cursor
        ? (cursor.startsWith("http")
            ? cursor
            : cursor.startsWith("/")
              ? `${DEFAULTS.BASE_SCHEMA_URL}${cursor}`
              : `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups?${filter}&orderby=title&limit=${limit}&start=${encodeURIComponent(cursor)}`)
        : `${DEFAULTS.BASE_SCHEMA_URL}/tenant/fieldgroups?${filter}&orderby=title&limit=${limit}`;
      const tenantRes = await apiCall(tenantUrl, "GET", schemaHeaders(token, cfg, "application/vnd.adobe.xed-id+json"));
      const globalRes = include_global
        ? await apiCall(`${DEFAULTS.BASE_SCHEMA_URL}/global/fieldgroups?${filter}&orderby=title&limit=${limit}`, "GET", schemaHeaders(token, cfg, "application/vnd.adobe.xed-id+json"))
        : null;

      if (!tenantRes.ok)
        return { content: [{ type: "text", text: `❌ Fieldgroup list failed (${tenantRes.status}):\n${JSON.stringify(tenantRes.body, null, 2)}` }] };

      const tenantItems = extractItems(tenantRes.body);
      const globalItems = globalRes?.ok ? extractItems(globalRes.body) : [];
      // Schema Registry returns _page.next as the next "start" value (a scalar
      // matching the orderby field, e.g. a title string). Pass it back and
      // we'll wrap it into ?start= on the next call.
      const tenantNextHref = tenantRes.body._links?.next?.href
        || tenantRes.body._page?.next?.href
        || tenantRes.body._page?.next;
      const fmt = items => items.map(fg =>
        `  • ${fg.title || "untitled"}\n    altId  : ${fg["meta:altId"]||"?"}\n    $id    : ${fg["$id"]||"?"}\n    version: ${fg.version||"?"}`
      ).join("\n\n");

      return { content: [{ type: "text", text:
`📋 FIELDGROUPS FOR OFFER ITEM CLASS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Class   : ${cfg.OOB_OFFER_CLASS}
Sandbox : ${cfg.SANDBOX_NAME}

🏢 YOUR TENANT FIELDGROUPS (${tenantItems.length} on this page):
${tenantItems.length ? fmt(tenantItems) : "  (none — no custom fieldgroups created yet)"}
${tenantNextHref ? `\n⏭️  More tenant fieldgroups. Call list_schema_fieldgroups again with:\n     cursor: "${tenantNextHref}"` : ""}

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

  // ════════ TOOL 22 — update_collection ════════════════════════════════════════
  server.tool("update_collection",
    "Update an existing item collection using JSON Patch operations. Pass filter_expression to regenerate the constraint (supports the same operators and multi-condition and/or as create_collection) instead of hand-writing a /constraints patch. Requires confirmed: true to execute.",
    {
      collection_id: z.string().describe("Collection ID or exact collection name e.g. dps:item-collection:xxxxx"),
      patches: z.array(z.object({
        op:    z.enum(["replace","add","remove"]),
        path:  z.string(),
        value: z.any().optional(),
      })).default([]).describe("JSON Patch operations. Common paths: /name, /description. Don't hand-write /constraints — use filter_expression instead."),
      filter_expression: z.string().optional().describe(`New filter to replace the collection's constraint, e.g. 'category.equals("Skincare")' or 'category.contains("Skin") or itemPriority.greaterThan(3)', or "all".`),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ collection_id, patches, filter_expression, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });

      const resolve = await resolveCollectionIdentifier(collection_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      let finalPatches = patches;
      let filterNote = "No change to the filter constraint.";
      let warning = null;

      if (filter_expression) {
        const current = resolve.body ? { ok: true, body: resolve.body } : await apiCall(`${DEFAULTS.BASE_DPS_URL}/item-collections/${resolvedId}`, "GET", dpsHeaders(token, cfg));
        if (!current.ok)
          return { content: [{ type: "text", text: `❌ Could not fetch current collection ${resolvedId} to rebuild its constraint (${current.status}): ${JSON.stringify(current.body)}` }] };

        const itemCatalogId = current.body.constraints?.[0]?.itemCatalogId || cfg.ITEM_CATALOG_ID;
        const built = pqlToUiModel(filter_expression, cfg.TENANT_ID);
        warning = built.warning;
        finalPatches = [
          ...patches,
          { op: current.body.constraints?.length ? "replace" : "add", path: "/constraints",
            value: [{ itemCatalogId, uiModel: built.uiModel }] },
        ];
        filterNote = `Filter will be replaced with: ${filter_expression}`;
      }

      const check = await needsConfirmation(server, confirmed,
`COLLECTION TO UPDATE:
  Collection ID : ${resolvedId}${collection_id !== resolvedId ? ` (resolved from "${collection_id}")` : ""}
  Sandbox       : ${cfg.SANDBOX_NAME}

PATCHES TO APPLY:
${finalPatches.map(p => `  ${p.op} ${p.path}${p.value !== undefined ? ` = ${p.path === "/constraints" ? "[regenerated constraint — see note below]" : JSON.stringify(p.value)}` : ""}`).join("\n") || "  (none)"}

${filterNote}
${warning ? `\n⚠️  ${warning}\n` : ""}
This will PATCH /item-collections/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/item-collections/${resolvedId}`, "PATCH",
        dpsHeaders(token, cfg), finalPatches
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Collection ${resolvedId} updated successfully\netag: ${res.body.etag || "?"}\n${filterNote}${warning ? `\n⚠️  ${warning}` : ""}`
        : `❌ Update failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 23 — update_eligibility_rule ══════════════════════════════════
  server.tool("update_eligibility_rule",
    "Update an existing eligibility rule using JSON Patch operations. If /condition, /name, or /description change, also regenerates segmentModel to match, so the rule stays correctly rendered in AJO's Rule Builder UI. Requires confirmed: true to execute.",
    {
      rule_id: z.string().describe("Eligibility rule ID or exact rule name e.g. dps:eligibility-rule:xxxxx"),
      patches: z.array(z.object({
        op:    z.enum(["replace","add","remove"]),
        path:  z.string(),
        value: z.any().optional(),
      })).describe("JSON Patch operations. Common paths: /name, /description, /condition. Do not pass your own /segmentModel patch — it's derived automatically from the final condition/name/description."),
      merge_policy_id: z.string().optional().describe("Override mergePolicyId in the regenerated segmentModel. Defaults to the rule's existing mergePolicyId, then MERGE_POLICY_ID config/header."),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ rule_id, patches, merge_policy_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });

      const resolve = await resolveEligibilityRuleIdentifier(rule_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      // Fetch current state so segmentModel can be regenerated even when a
      // patch only touches /name or /description without also touching
      // /condition (segmentModel embeds name/description too).
      const current = resolve.body ? { ok: true, body: resolve.body } : await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-rules/${resolvedId}`, "GET", dpsHeaders(token, cfg));
      if (!current.ok)
        return { content: [{ type: "text", text: `❌ Could not fetch current rule ${resolvedId} to regenerate segmentModel (${current.status}): ${JSON.stringify(current.body)}` }] };

      const touchesRelevantField = patches.some(p => ["/condition","/condition/value","/name","/description"].includes(p.path));
      const callerSuppliedSegmentModel = patches.some(p => p.path === "/segmentModel" || p.path.startsWith("/segmentModel/"));

      let finalPatches = patches;
      let segmentModelNote = "No changes to /condition, /name, or /description — segmentModel left as-is.";
      let warning = null;

      if (touchesRelevantField && !callerSuppliedSegmentModel) {
        const nameP  = patches.find(p => p.path === "/name");
        const descP  = patches.find(p => p.path === "/description");
        const condP  = patches.find(p => p.path === "/condition" || p.path === "/condition/value");

        if (condP && condP.op === "remove") {
          // Condition is being removed entirely — there's no PQL left to derive
          // a segmentModel from, so drop segmentModel too instead of building one
          // from missing data.
          finalPatches = current.body.segmentModel
            ? [...patches, { op: "remove", path: "/segmentModel" }]
            : patches;
          segmentModelNote = current.body.segmentModel
            ? "condition removed — segmentModel removed as well (no PQL left to derive it from)."
            : "condition removed — no segmentModel existed to remove.";
        } else {
          const finalName  = nameP && nameP.op !== "remove" ? nameP.value : current.body.name;
          const finalDesc  = descP && descP.op !== "remove" ? descP.value : current.body.description;
          const finalPql   = condP
            ? (condP.path === "/condition" ? condP.value?.value : condP.value)
            : current.body.condition?.value;

          const mergePolicyId = merge_policy_id || current.body.segmentModel?.mergePolicyId || cfg.MERGE_POLICY_ID;
          const built = pqlToSegmentModel({ pql: finalPql, name: finalName, description: finalDesc, mergePolicyId });
          warning = built.warning;

          finalPatches = [
            ...patches,
            { op: current.body.segmentModel ? "replace" : "add", path: "/segmentModel", value: built.segmentModel },
          ];
          segmentModelNote = `segmentModel will be regenerated to match (mergePolicyId: ${mergePolicyId || "none set — UI may prompt for one"}).`;
        }
      } else if (callerSuppliedSegmentModel) {
        segmentModelNote = "Caller supplied an explicit /segmentModel patch — using it as-is, not auto-regenerating.";
      }

      const check = await needsConfirmation(server, confirmed,
`ELIGIBILITY RULE TO UPDATE:
  Rule ID : ${resolvedId}${rule_id !== resolvedId ? ` (resolved from "${rule_id}")` : ""}
  Sandbox : ${cfg.SANDBOX_NAME}

PATCHES TO APPLY:
${finalPatches.map(p => `  ${p.op} ${p.path}${p.value !== undefined ? ` = ${p.path === "/segmentModel" ? "[regenerated segmentModel — see note below]" : JSON.stringify(p.value)}` : ""}`).join("\n")}

${segmentModelNote}
${warning ? `\n⚠️  ${warning}\n` : ""}
This will PATCH /offer-rules/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-rules/${resolvedId}`, "PATCH",
        dpsHeaders(token, cfg), finalPatches
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Eligibility rule ${resolvedId} updated successfully\netag: ${res.body.etag || "?"}\n${segmentModelNote}${warning ? `\n⚠️  ${warning}` : ""}`
        : `❌ Update failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 24 — update_ranking_formula ═══════════════════════════════════
  server.tool("update_ranking_formula",
    "Update an existing ranking formula using JSON Patch operations. If /expression changes, also regenerates uiModel to match, so the formula stays correctly rendered in AJO's visual Ranking Builder. Requires confirmed: true to execute.",
    {
      ranking_formula_id: z.string().optional().describe("Ranking formula ID or exact formula name e.g. dps:ranking-function:xxxxx"),
      formula_id:         z.string().optional().describe("Legacy alias for ranking_formula_id. Prefer ranking_formula_id."),
      patches: z.array(z.object({
        op:    z.enum(["replace","add","remove"]),
        path:  z.string(),
        value: z.any().optional(),
      })).describe("JSON Patch operations. Common paths: /name, /description, /expression, /definedOn. Do not pass your own /uiModel patch — it's derived automatically from the final expression."),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ ranking_formula_id, formula_id: formula_id_legacy, patches, confirmed, access_token }) => {
      const formula_id = ranking_formula_id || formula_id_legacy;
      if (!formula_id) return { content: [{ type: "text", text: "❌ Provide ranking_formula_id (ID or exact name)." }] };
      const { cfg, token } = await requireApiConfig({ access_token });

      const resolve = await resolveRankingFormulaIdentifier(formula_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      const exprP = patches.find(p => p.path === "/expression" || p.path === "/expression/value");
      const callerSuppliedUiModel = patches.some(p => p.path === "/uiModel" || p.path.startsWith("/uiModel/"));

      let finalPatches = patches;
      let uiModelNote = "No change to /expression — uiModel left as-is.";
      let warning = null;

      if (exprP && !callerSuppliedUiModel) {
        // Fetch current state so we know whether uiModel already exists (add
        // vs replace) and can drop it cleanly if the new expression can't be
        // translated.
        const current = resolve.body ? { ok: true, body: resolve.body } : await apiCall(`${DEFAULTS.BASE_DPS_URL}/ranking-formulas/${resolvedId}`, "GET", dpsHeaders(token, cfg));
        if (!current.ok)
          return { content: [{ type: "text", text: `❌ Could not fetch current ranking formula ${resolvedId} to regenerate uiModel (${current.status}): ${JSON.stringify(current.body)}` }] };

        if (exprP.op === "remove") {
          finalPatches = current.body.uiModel
            ? [...patches, { op: "remove", path: "/uiModel" }]
            : patches;
          uiModelNote = current.body.uiModel
            ? "expression removed — uiModel removed as well (no PQL left to derive it from)."
            : "expression removed — no uiModel existed to remove.";
        } else {
          const newPql = exprP.path === "/expression" ? exprP.value?.value : exprP.value;
          const built = pqlToRankingUiModel(newPql);
          warning = built.warning;
          if (built.uiModel) {
            finalPatches = [
              ...patches,
              { op: current.body.uiModel ? "replace" : "add", path: "/uiModel", value: built.uiModel },
            ];
            uiModelNote = "uiModel will be regenerated to match the new expression.";
          } else if (current.body.uiModel) {
            finalPatches = [...patches, { op: "remove", path: "/uiModel" }];
            uiModelNote = "New expression isn't a simple if/else chain — stale uiModel removed rather than left mismatched.";
          } else {
            uiModelNote = "New expression isn't a simple if/else chain — no uiModel generated (formula still works via PQL).";
          }
        }
      } else if (callerSuppliedUiModel) {
        uiModelNote = "Caller supplied an explicit /uiModel patch — using it as-is, not auto-regenerating.";
      }

      const check = await needsConfirmation(server, confirmed,
`RANKING FORMULA TO UPDATE:
  Formula ID : ${resolvedId}${formula_id !== resolvedId ? ` (resolved from "${formula_id}")` : ""}
  Sandbox    : ${cfg.SANDBOX_NAME}

PATCHES TO APPLY:
${finalPatches.map(p => `  ${p.op} ${p.path}${p.value !== undefined ? ` = ${p.path === "/uiModel" ? "[regenerated uiModel — see note below]" : JSON.stringify(p.value)}` : ""}`).join("\n")}

${uiModelNote}
${warning ? `\n⚠️  ${warning}\n` : ""}
This will PATCH /ranking-formulas/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/ranking-formulas/${resolvedId}`, "PATCH",
        dpsHeaders(token, cfg), finalPatches
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Ranking formula ${resolvedId} updated successfully\netag: ${res.body.etag || "?"}\n${uiModelNote}${warning ? `\n⚠️  ${warning}` : ""}`
        : `❌ Update failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 25 — update_selection_strategy ════════════════════════════════
  server.tool("update_selection_strategy",
    "Update an existing selection strategy using JSON Patch operations. Requires confirmed: true to execute.",
    {
      selection_strategy_id: z.string().optional().describe("Selection strategy ID or exact strategy name e.g. dps:selection-strategy:xxxxx"),
      strategy_id:           z.string().optional().describe("Legacy alias for selection_strategy_id. Prefer selection_strategy_id."),
      patches: z.array(z.object({
        op:    z.enum(["replace","add","remove"]),
        path:  z.string(),
        value: z.any().optional(),
      })).describe("JSON Patch operations. Common paths: /name, /description, /rank, /profileConstraint, /optionSelection"),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ selection_strategy_id, strategy_id: strategy_id_legacy, patches, confirmed, access_token }) => {
      const strategy_id = selection_strategy_id || strategy_id_legacy;
      if (!strategy_id) return { content: [{ type: "text", text: "❌ Provide selection_strategy_id (ID or exact name)." }] };
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveSelectionStrategyIdentifier(strategy_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      const check = await needsConfirmation(server, confirmed,
`SELECTION STRATEGY TO UPDATE:
  Strategy ID : ${resolvedId}${strategy_id !== resolvedId ? ` (resolved from "${strategy_id}")` : ""}
  Sandbox     : ${cfg.SANDBOX_NAME}

PATCHES TO APPLY:
${patches.map(p => `  ${p.op} ${p.path}${p.value !== undefined ? ` = ${JSON.stringify(p.value)}` : ""}`).join("\n")}

This will PATCH /selection-strategies/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/selection-strategies/${resolvedId}`, "PATCH",
        dpsHeaders(token, cfg), patches
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Selection strategy ${resolvedId} updated successfully\netag: ${res.body.etag || "?"}`
        : `❌ Update failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 26 — update_placement ═════════════════════════════════════════
  server.tool("update_placement",
    "Update an existing ExD placement using PUT (full replace). Placements use PUT not PATCH per the DPS API. Requires confirmed: true to execute.",
    {
      placement_id: z.string().describe("Placement ID or exact placement name e.g. dps:exd-placement:xxxxx"),
      name:         z.string().optional().describe("New display name"),
      description:  z.string().optional().describe("New description"),
      status:       z.enum(["active","archived"]).optional().describe("New status"),
      channel:      z.string().optional().describe("Channel URI e.g. https://ns.adobe.com/xdm/channel-types/web"),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ placement_id, name, description, status, channel, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });

      const resolve = await resolvePlacementIdentifier(placement_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      // Fetch current placement to merge fields (PUT requires full body)
      const getRes = resolve.body ? { ok: true, body: resolve.body } : await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/exd-placements/${resolvedId}`, "GET",
        placementHeaders(token, cfg)
      );
      if (!getRes.ok)
        return { content: [{ type: "text", text: `❌ Could not fetch placement for update (${getRes.status}): ${JSON.stringify(getRes.body)}` }] };

      const current = getRes.body;
      const payload = {
        id:          resolvedId,
        name:        name        ?? current.name,
        description: description ?? current.description ?? "",
        status:      status      ?? current.status,
        channel:     channel     ?? current.channel,
      };

      const check = await needsConfirmation(server, confirmed,
`PLACEMENT TO UPDATE (PUT — full replace):
  Placement ID : ${resolvedId}${placement_id !== resolvedId ? ` (resolved from "${placement_id}")` : ""}
  Sandbox      : ${cfg.SANDBOX_NAME}

NEW VALUES:
  name        : ${payload.name}
  description : ${payload.description}
  status      : ${payload.status}
  channel     : ${payload.channel}

This will PUT /exd-placements/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/exd-placements/${resolvedId}`, "PUT",
        placementHeaders(token, cfg), payload
      );
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ Update failed (${res.status}): ${JSON.stringify(res.body)}` }] };

      // The PUT response doesn't echo back the stored object, and this endpoint
      // has been observed to silently ignore a /name change (200 OK, etag bumps,
      // but the name is left untouched) — so verify what was actually persisted
      // rather than trusting the request payload.
      const verifyRes = await apiCall(`${DEFAULTS.BASE_DPS_URL}/exd-placements/${resolvedId}`, "GET", placementHeaders(token, cfg));
      const persisted = verifyRes.ok ? verifyRes.body : null;
      const nameMismatch = persisted && persisted.name !== payload.name;

      return { content: [{ type: "text", text:
`✅ Placement ${resolvedId} updated successfully
Name   : ${persisted?.name ?? payload.name}
Status : ${persisted?.status ?? payload.status}
${nameMismatch ? `\n⚠️  Requested name "${payload.name}" was not persisted by the API — placement name appears immutable after creation on this endpoint. Current name is still "${persisted.name}".` : ""}` }] };
    })
  );

  // ════════ TOOL 27 — get_collection ═══════════════════════════════════════════
  server.tool("get_collection",
    "Look up a single item collection by its DPS ID or exact collection name. Read-only.",
    {
      collection_id: z.string().describe("Collection ID or exact collection name e.g. dps:item-collection:xxxxx. A name matching more than one collection fails with an error listing the matches."),
      access_token:  z.string().optional(),
    },
    wrap(async ({ collection_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveCollectionIdentifier(collection_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      if (resolve.body) return { content: [{ type: "text", text: JSON.stringify(resolve.body, null, 2) }] };
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/item-collections/${resolve.id}`, "GET", dpsHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 28 — list_collections ═════════════════════════════════════════
  server.tool("list_collections",
    "List item collections in the sandbox. Read-only. Uses cursor pagination — pass `cursor` from the previous response for the next page.",
    {
      limit:        z.number().default(20),
      cursor:       z.string().optional().describe("Opaque next-page token from a previous response. Omit for the first page."),
      offset:       z.number().optional().describe("Deprecated: Adobe DPS ignores this. Use cursor instead."),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const url = cursor
        ? (cursor.startsWith("http") ? cursor : `${DEFAULTS.BASE_DPS_URL}${cursor}`)
        : `${DEFAULTS.BASE_DPS_URL}/item-collections?limit=${limit}`;
      const res = await apiCall(url, "GET", dpsHeaders(token, cfg));
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      const nextHref = res.body._links?.next?.href;
      if (!items.length)
        return { content: [{ type: "text", text:
`⚠️ 0 items returned.
Total reported by API : ${res.body.total ?? res.body.count ?? "unknown"}
Raw response          : ${JSON.stringify(res.body, null, 2)}` }] };

      return { content: [{ type: "text", text:
`📋 Collections (${items.length} on this page):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(i => `  • ${i.name || "unnamed"} | ID: ${i.id || "?"}`).join("\n")}
${nextHref ? `\n⏭️  More pages available. Call list_collections again with:\n     cursor: "${nextHref}"` : `\n✅ End of results.`}` }] };
    })
  );

  // ════════ TOOL 29 — delete_collection ════════════════════════════════════════
  server.tool("delete_collection",
    "Permanently delete an item collection. Requires confirmed: true to execute. This cannot be undone — any selection strategy still referencing this collection will break.",
    {
      collection_id: z.string().describe("Collection ID or exact collection name e.g. dps:item-collection:xxxxx"),
      confirmed:     boolish(),
      access_token:  z.string().optional(),
    },
    wrap(async ({ collection_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveCollectionIdentifier(collection_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      // Only scan for dependencies on the FIRST call (no confirmed) so the
      // second-call fast path doesn't repeat the ~1-2s scan.
      let depPreview = "";
      if (!confirmed) {
        const { refs, truncated, error } = await findSelectionStrategyReferences(resolvedId, token, cfg);
        depPreview = "\n" + formatDependencyPreview("collection", refs, truncated, error) + "\n";
      }

      const check = await needsConfirmation(server, confirmed,
`COLLECTION TO DELETE:
  Collection ID : ${resolvedId}${collection_id !== resolvedId ? ` (resolved from "${collection_id}")` : ""}
  Sandbox       : ${cfg.SANDBOX_NAME}
${depPreview}
This will DELETE /item-collections/${resolvedId}. This cannot be undone.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/item-collections/${resolvedId}`, "DELETE",
        dpsHeaders(token, cfg)
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Collection ${resolvedId} deleted successfully`
        : `❌ Delete failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 30 — get_eligibility_rule ═════════════════════════════════════
  server.tool("get_eligibility_rule",
    "Look up a single eligibility rule by its DPS ID or exact rule name. Read-only.",
    {
      rule_id:      z.string().describe("Eligibility rule ID or exact rule name e.g. dps:eligibility-rule:xxxxx. A name matching more than one rule fails with an error listing the matches."),
      access_token: z.string().optional(),
    },
    wrap(async ({ rule_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveEligibilityRuleIdentifier(rule_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      if (resolve.body) return { content: [{ type: "text", text: JSON.stringify(resolve.body, null, 2) }] };
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-rules/${resolve.id}`, "GET", dpsHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 31 — list_eligibility_rules ═══════════════════════════════════
  server.tool("list_eligibility_rules",
    "List ExD eligibility rules in the sandbox. Read-only. Filters to exdRule==true. Uses cursor pagination — pass `cursor` from the previous response for the next page.",
    {
      limit:        z.number().default(20),
      cursor:       z.string().optional().describe("Opaque next-page token from a previous response. Omit for the first page."),
      offset:       z.number().optional().describe("Deprecated: Adobe DPS ignores this. Use cursor instead."),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const url = cursor
        ? (cursor.startsWith("http") ? cursor : `${DEFAULTS.BASE_DPS_URL}${cursor}`)
        : `${DEFAULTS.BASE_DPS_URL}/offer-rules?property=exdRule%3D%3Dtrue&limit=${limit}`;
      const res = await apiCall(url, "GET", dpsHeaders(token, cfg));
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      const nextHref = res.body._links?.next?.href;
      if (!items.length)
        return { content: [{ type: "text", text:
`⚠️ 0 items returned.
Total reported by API : ${res.body.total ?? res.body.count ?? "unknown"}
Raw response          : ${JSON.stringify(res.body, null, 2)}` }] };

      return { content: [{ type: "text", text:
`📋 Eligibility rules (${items.length} on this page):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(i => `  • ${i.name || "unnamed"} | ID: ${i.id || "?"}`).join("\n")}
${nextHref ? `\n⏭️  More pages available. Call list_eligibility_rules again with:\n     cursor: "${nextHref}"` : `\n✅ End of results.`}` }] };
    })
  );

  // ════════ TOOL 32 — delete_eligibility_rule ══════════════════════════════════
  server.tool("delete_eligibility_rule",
    "Permanently delete an eligibility rule. Requires confirmed: true to execute. This cannot be undone — any selection strategy still referencing this rule will break.",
    {
      rule_id:      z.string().describe("Eligibility rule ID or exact rule name e.g. dps:eligibility-rule:xxxxx"),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ rule_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveEligibilityRuleIdentifier(rule_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      let depPreview = "";
      if (!confirmed) {
        const { refs, truncated, error } = await findSelectionStrategyReferences(resolvedId, token, cfg);
        depPreview = "\n" + formatDependencyPreview("eligibility rule", refs, truncated, error) + "\n";
      }

      const check = await needsConfirmation(server, confirmed,
`ELIGIBILITY RULE TO DELETE:
  Rule ID : ${resolvedId}${rule_id !== resolvedId ? ` (resolved from "${rule_id}")` : ""}
  Sandbox : ${cfg.SANDBOX_NAME}
${depPreview}
This will DELETE /offer-rules/${resolvedId}. This cannot be undone.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-rules/${resolvedId}`, "DELETE",
        dpsHeaders(token, cfg)
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Eligibility rule ${resolvedId} deleted successfully`
        : `❌ Delete failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 33 — get_ranking_formula ══════════════════════════════════════
  server.tool("get_ranking_formula",
    "Look up a single ranking formula by its DPS ID or exact formula name. Read-only.",
    {
      ranking_formula_id: z.string().optional().describe("Ranking formula ID or exact formula name e.g. dps:ranking-function:xxxxx. A name matching more than one formula fails with an error listing the matches."),
      formula_id:         z.string().optional().describe("Legacy alias for ranking_formula_id. Prefer ranking_formula_id."),
      access_token:       z.string().optional(),
    },
    wrap(async ({ ranking_formula_id, formula_id, access_token }) => {
      const id = ranking_formula_id || formula_id;
      if (!id) return { content: [{ type: "text", text: "❌ Provide ranking_formula_id (ID or exact name)." }] };
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveRankingFormulaIdentifier(id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      if (resolve.body) return { content: [{ type: "text", text: JSON.stringify(resolve.body, null, 2) }] };
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/ranking-formulas/${resolve.id}`, "GET", dpsHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 34 — list_ranking_formulas ════════════════════════════════════
  server.tool("list_ranking_formulas",
    "List ExD ranking formulas in the sandbox. Read-only. Filters to exdFunction==true. Uses cursor pagination — pass `cursor` from the previous response for the next page.",
    {
      limit:        z.number().default(20),
      cursor:       z.string().optional().describe("Opaque next-page token from a previous response. Omit for the first page."),
      offset:       z.number().optional().describe("Deprecated: Adobe DPS ignores this. Use cursor instead."),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const url = cursor
        ? (cursor.startsWith("http") ? cursor : `${DEFAULTS.BASE_DPS_URL}${cursor}`)
        : `${DEFAULTS.BASE_DPS_URL}/ranking-formulas?property=exdFunction%3D%3Dtrue&limit=${limit}`;
      const res = await apiCall(url, "GET", dpsHeaders(token, cfg));
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      const nextHref = res.body._links?.next?.href;
      if (!items.length)
        return { content: [{ type: "text", text:
`⚠️ 0 items returned.
Total reported by API : ${res.body.total ?? res.body.count ?? "unknown"}
Raw response          : ${JSON.stringify(res.body, null, 2)}` }] };

      return { content: [{ type: "text", text:
`📋 Ranking formulas (${items.length} on this page):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(i => `  • ${i.name || "unnamed"} | ID: ${i.id || "?"}`).join("\n")}
${nextHref ? `\n⏭️  More pages available. Call list_ranking_formulas again with:\n     cursor: "${nextHref}"` : `\n✅ End of results.`}` }] };
    })
  );

  // ════════ TOOL 35 — delete_ranking_formula ═══════════════════════════════════
  server.tool("delete_ranking_formula",
    "Permanently delete a ranking formula. Requires confirmed: true to execute. This cannot be undone — any selection strategy still referencing this formula will break.",
    {
      ranking_formula_id: z.string().optional().describe("Ranking formula ID or exact formula name e.g. dps:ranking-function:xxxxx"),
      formula_id:         z.string().optional().describe("Legacy alias for ranking_formula_id. Prefer ranking_formula_id."),
      confirmed:          boolish(),
      access_token:       z.string().optional(),
    },
    wrap(async ({ ranking_formula_id, formula_id, confirmed, access_token }) => {
      const inputId = ranking_formula_id || formula_id;
      if (!inputId) return { content: [{ type: "text", text: "❌ Provide ranking_formula_id (ID or exact name)." }] };
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveRankingFormulaIdentifier(inputId, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      let depPreview = "";
      if (!confirmed) {
        const { refs, truncated, error } = await findSelectionStrategyReferences(resolvedId, token, cfg);
        depPreview = "\n" + formatDependencyPreview("ranking formula", refs, truncated, error) + "\n";
      }

      const check = await needsConfirmation(server, confirmed,
`RANKING FORMULA TO DELETE:
  Formula ID : ${resolvedId}${inputId !== resolvedId ? ` (resolved from "${inputId}")` : ""}
  Sandbox    : ${cfg.SANDBOX_NAME}
${depPreview}
This will DELETE /ranking-formulas/${resolvedId}. This cannot be undone.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/ranking-formulas/${resolvedId}`, "DELETE",
        dpsHeaders(token, cfg)
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Ranking formula ${resolvedId} deleted successfully`
        : `❌ Delete failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 36 — get_selection_strategy ═══════════════════════════════════
  server.tool("get_selection_strategy",
    "Look up a single selection strategy by its DPS ID or exact strategy name. Read-only.",
    {
      selection_strategy_id: z.string().optional().describe("Selection strategy ID or exact strategy name e.g. dps:selection-strategy:xxxxx. A name matching more than one strategy fails with an error listing the matches."),
      strategy_id:           z.string().optional().describe("Legacy alias for selection_strategy_id. Prefer selection_strategy_id."),
      access_token:          z.string().optional(),
    },
    wrap(async ({ selection_strategy_id, strategy_id, access_token }) => {
      const id = selection_strategy_id || strategy_id;
      if (!id) return { content: [{ type: "text", text: "❌ Provide selection_strategy_id (ID or exact name)." }] };
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveSelectionStrategyIdentifier(id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      if (resolve.body) return { content: [{ type: "text", text: JSON.stringify(resolve.body, null, 2) }] };
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/selection-strategies/${resolve.id}`, "GET", dpsHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 37 — list_selection_strategies ════════════════════════════════
  server.tool("list_selection_strategies",
    "List selection strategies in the sandbox. Read-only. Uses cursor pagination — pass `cursor` from the previous response for the next page.",
    {
      limit:        z.number().default(20),
      cursor:       z.string().optional().describe("Opaque next-page token from a previous response. Omit for the first page."),
      offset:       z.number().optional().describe("Deprecated: Adobe DPS ignores this. Use cursor instead."),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const url = cursor
        ? (cursor.startsWith("http") ? cursor : `${DEFAULTS.BASE_DPS_URL}${cursor}`)
        : `${DEFAULTS.BASE_DPS_URL}/selection-strategies?limit=${limit}`;
      const res = await apiCall(url, "GET", dpsHeaders(token, cfg));
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      const nextHref = res.body._links?.next?.href;
      if (!items.length)
        return { content: [{ type: "text", text:
`⚠️ 0 items returned.
Total reported by API : ${res.body.total ?? res.body.count ?? "unknown"}
Raw response          : ${JSON.stringify(res.body, null, 2)}` }] };

      return { content: [{ type: "text", text:
`📋 Selection strategies (${items.length} on this page):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(i => `  • ${i.name || "unnamed"} | ID: ${i.id || "?"}`).join("\n")}
${nextHref ? `\n⏭️  More pages available. Call list_selection_strategies again with:\n     cursor: "${nextHref}"` : `\n✅ End of results.`}` }] };
    })
  );

  // ════════ TOOL 38 — delete_selection_strategy ════════════════════════════════
  server.tool("delete_selection_strategy",
    "Permanently delete a selection strategy. Requires confirmed: true to execute. This cannot be undone — any placement or journey still referencing this strategy will break.",
    {
      selection_strategy_id: z.string().optional().describe("Selection strategy ID or exact strategy name e.g. dps:selection-strategy:xxxxx"),
      strategy_id:           z.string().optional().describe("Legacy alias for selection_strategy_id. Prefer selection_strategy_id."),
      confirmed:             boolish(),
      access_token:          z.string().optional(),
    },
    wrap(async ({ selection_strategy_id, strategy_id, confirmed, access_token }) => {
      const inputId = selection_strategy_id || strategy_id;
      if (!inputId) return { content: [{ type: "text", text: "❌ Provide selection_strategy_id (ID or exact name)." }] };
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveSelectionStrategyIdentifier(inputId, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      const check = await needsConfirmation(server, confirmed,
`SELECTION STRATEGY TO DELETE:
  Strategy ID : ${resolvedId}${inputId !== resolvedId ? ` (resolved from "${inputId}")` : ""}
  Sandbox     : ${cfg.SANDBOX_NAME}

⚠️  This cannot be undone. Any placement or journey referencing this strategy will break.

This will DELETE /selection-strategies/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/selection-strategies/${resolvedId}`, "DELETE",
        dpsHeaders(token, cfg)
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Selection strategy ${resolvedId} deleted successfully`
        : `❌ Delete failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 39 — get_placement ═════════════════════════════════════════════
  server.tool("get_placement",
    "Look up a single ExD channel placement by its DPS ID or exact placement name. Read-only.",
    {
      placement_id: z.string().describe("Placement ID or exact placement name e.g. dps:exd-placement:xxxxx. A name matching more than one placement fails with an error listing the matches."),
      access_token: z.string().optional(),
    },
    wrap(async ({ placement_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolvePlacementIdentifier(placement_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      if (resolve.body) return { content: [{ type: "text", text: JSON.stringify(resolve.body, null, 2) }] };
      const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/exd-placements/${resolve.id}`, "GET", placementHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 40a — list_placements ═════════════════════════════════════════
  server.tool("list_placements",
    "List channel placements in this sandbox. Read-only. Placements are the surfaces that Selection Strategies deliver offers to (web slot, email block, push channel, etc.). Cursor-paginate via `_links.next.href` (pass the returned cursor back in on the next call).",
    {
      limit:        z.number().default(20),
      cursor:       z.string().optional().describe("Opaque next-page token from a previous response. Omit for the first page."),
      access_token: z.string().optional(),
    },
    wrap(async ({ limit, cursor, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const url = cursor
        ? (cursor.startsWith("http") ? cursor : `${DEFAULTS.BASE_DPS_URL}${cursor}`)
        : `${DEFAULTS.BASE_DPS_URL}/exd-placements?limit=${limit}`;
      const res = await apiCall(url, "GET", placementHeaders(token, cfg));
      if (!res.ok)
        return { content: [{ type: "text", text: `❌ (${res.status}):\n${JSON.stringify(res.body, null, 2)}` }] };

      const items = extractItems(res.body);
      const nextHref = res.body._links?.next?.href;
      if (!items.length)
        return { content: [{ type: "text", text:
`ℹ️ No placements found in ${cfg.SANDBOX_NAME}.
Create one with create_placement before wiring a selection_strategy.` }] };

      return { content: [{ type: "text", text:
`📋 Placements (${items.length} on this page):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(p => `  • ${p.name || "unnamed"} | Channel: ${(p.channel||"").split("/").pop()||"?"} | Status: ${p.status||"-"} | ID: ${p.id||"?"}`).join("\n")}
${nextHref ? `\n⏭️  More pages available. Call list_placements again with:\n     cursor: "${nextHref}"` : `\n✅ End of results — no more pages.`}` }] };
    })
  );

  // ════════ TOOL 40b — list_audiences ══════════════════════════════════════════
  server.tool("list_audiences",
    "List RT-CDP audience segments available in this sandbox. Read-only. Use this before attach_offer_eligibility_rule or bulk_create_offers (audience column) so you know what audience names/IDs exist. Returns up to ~2000 audiences (pages internally).",
    {
      access_token: z.string().optional(),
    },
    wrap(async ({ access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const { items, error } = await fetchAllAudiences(token, cfg);
      if (error) return { content: [{ type: "text", text: `❌ Failed to list audiences ${error}` }] };
      if (!items.length)
        return { content: [{ type: "text", text: `ℹ️ No RT-CDP audiences found in ${cfg.SANDBOX_NAME}.` }] };

      return { content: [{ type: "text", text:
`👥 RT-CDP Audiences (${items.length} total in ${cfg.SANDBOX_NAME}):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${items.map(a => `  • ${a.name || "unnamed"} | Type: ${a.type || "-"} | ID: ${a.id || "?"}`).join("\n")}` }] };
    })
  );

  // ════════ TOOL 40c — get_audience ═════════════════════════════════════════════
  server.tool("get_audience",
    "Look up a single RT-CDP audience by its segment ID or exact name. Read-only. Useful before creating an eligibility rule that wraps this audience.",
    {
      audience_id:  z.string().describe("Audience segment ID (UUID) or exact audience name. If a name matches more than one audience, the call fails with the list of matches."),
      access_token: z.string().optional(),
    },
    wrap(async ({ audience_id, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolveAudienceIdentifier(audience_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const res = await apiCall(`${DEFAULTS.BASE_UPS_URL}/segment/definitions/${resolve.id}`, "GET", rtcdpHeaders(token, cfg));
      return { content: [{ type: "text", text: res.ok
        ? JSON.stringify(res.body, null, 2)
        : `❌ (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 40 — delete_offer_item ════════════════════════════════════════
  server.tool("delete_offer_item",
    "Permanently delete an offer item. Requires confirmed: true to execute. This cannot be undone — any collection whose filter matches this offer will simply no longer return it.",
    {
      offer_id:     z.string().describe("Offer item ID or exact offer name e.g. dps:<schemaHash>:xxxxx"),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ offer_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const offerResolve = await resolveOfferIdentifiers([offer_id], token, cfg);
      if (offerResolve.error) return { content: [{ type: "text", text: `❌ ${offerResolve.error}` }] };
      const resolvedId = offerResolve.ids[0];

      const check = await needsConfirmation(server, confirmed,
`OFFER ITEM TO DELETE:
  Offer ID : ${resolvedId}${offer_id !== resolvedId ? ` (resolved from "${offer_id}")` : ""}
  Sandbox  : ${cfg.SANDBOX_NAME}

⚠️  This cannot be undone. Prefer archiving (update_offer_item with lifecycleStatus: "archived") if you may want the offer back.

This will DELETE /offer-items/${resolvedId}.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/offer-items/${resolvedId}`, "DELETE",
        offerItemHeaders(token, cfg)
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Offer item ${resolvedId} deleted successfully`
        : `❌ Delete failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 41 — delete_placement ═════════════════════════════════════════
  server.tool("delete_placement",
    "Permanently delete an ExD channel placement. Requires confirmed: true to execute. This cannot be undone — any selection strategy wired to this placement will break.",
    {
      placement_id: z.string().describe("Placement ID or exact placement name e.g. dps:exd-placement:xxxxx"),
      confirmed:    boolish(),
      access_token: z.string().optional(),
    },
    wrap(async ({ placement_id, confirmed, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });
      const resolve = await resolvePlacementIdentifier(placement_id, token, cfg);
      if (resolve.error) return { content: [{ type: "text", text: `❌ ${resolve.error}` }] };
      const resolvedId = resolve.id;

      let depPreview = "";
      if (!confirmed) {
        const { refs, truncated, error } = await findSelectionStrategyReferences(resolvedId, token, cfg);
        depPreview = "\n" + formatDependencyPreview("placement", refs, truncated, error) + "\n";
      }

      const check = await needsConfirmation(server, confirmed,
`PLACEMENT TO DELETE:
  Placement ID : ${resolvedId}${placement_id !== resolvedId ? ` (resolved from "${placement_id}")` : ""}
  Sandbox      : ${cfg.SANDBOX_NAME}
${depPreview}
This will DELETE /exd-placements/${resolvedId}. This cannot be undone.`);
      if (check) return check;

      const res = await apiCall(
        `${DEFAULTS.BASE_DPS_URL}/exd-placements/${resolvedId}`, "DELETE",
        placementHeaders(token, cfg)
      );
      return { content: [{ type: "text", text: res.ok
        ? `✅ Placement ${resolvedId} deleted successfully`
        : `❌ Delete failed (${res.status}): ${JSON.stringify(res.body)}` }] };
    })
  );

  // ════════ TOOL 42 — bulk_update_offers ═══════════════════════════════════════
  server.tool("bulk_update_offers",
    "Update multiple existing offer items in one call, each with its own JSON Patch operations. Requires confirmed: true. Supports pagination via offset/limit: each call processes at most 30 updates to stay under Adobe I/O Runtime's 60s cap, then returns a 'call again with offset:X' instruction the LLM chains automatically.",
    {
      updates: z.array(z.object({
        offer_id: z.string().describe("Offer item ID or exact offer name"),
        patches:  z.array(z.object({
          op:    z.enum(["replace","add","remove"]),
          path:  z.string(),
          value: z.any().optional(),
        })).min(1).describe("JSON Patch operations for this offer"),
      })).min(1).describe("One entry per offer to update"),
      dry_run:      boolish().describe("Returns the patch payloads without calling the API. Names are shown unresolved since dry_run never makes API calls."),
      confirmed:    boolish().describe("Set to true to execute the write. Leave false to preview."),
      offset:       z.number().int().min(0).default(0).describe("Skip this many updates before processing. Use for pagination on big batches."),
      limit:        z.number().int().min(1).max(60).default(30).describe("Process at most this many updates in this call. Default 30 (safely fits Adobe's 60s function cap)."),
      chunk_size:   z.number().int().min(1).max(10).default(5).describe("How many PATCHes to issue in parallel per chunk. Default 5."),
      access_token: z.string().optional().describe("Bearer token — optional, server will auto-mint if missing"),
    },
    wrap(async ({ updates, dry_run, confirmed, offset, limit, chunk_size, access_token }) => {
      const totalUpdates = updates.length;
      const startIdx     = Math.min(offset, totalUpdates);
      const endIdx       = Math.min(offset + limit, totalUpdates);
      const window       = updates.slice(startIdx, endIdx);
      const windowLabel  = `updates ${startIdx + 1}-${endIdx} of ${totalUpdates}`;

      const fmtUpdate = (u, i) =>
        `${startIdx + i + 1}. ${u.offer_id}\n${u.patches.map(p => `   ${p.op} ${p.path}${p.value !== undefined ? ` = ${JSON.stringify(p.value)}` : ""}`).join("\n")}`;

      if (dry_run) return { content: [{ type: "text", text:
`🔍 DRY RUN — ${window.length} offer(s) would be updated (window: ${windowLabel}):
${window.slice(0, 10).map(fmtUpdate).join("\n\n")}${window.length > 10 ? `\n... (${window.length - 10} more not shown)` : ""}

Call again with dry_run: false and confirmed: true to execute.` }] };

      const { cfg, token } = await requireApiConfig({ access_token });

      const offerResolve = await resolveOfferIdentifiers(window.map(u => u.offer_id), token, cfg);
      if (offerResolve.error) return { content: [{ type: "text", text: `❌ Could not resolve offer_id(s): ${offerResolve.error}` }] };
      const resolvedUpdates = window.map((u, i) => ({ ...u, resolvedId: offerResolve.ids[i] }));

      const check = await needsConfirmation(server, confirmed,
`OFFERS TO UPDATE: ${resolvedUpdates.length} (window: ${windowLabel})
Sandbox : ${cfg.SANDBOX_NAME}

${resolvedUpdates.slice(0, 5).map((u, i) => `${startIdx + i + 1}. ${u.resolvedId}${u.offer_id !== u.resolvedId ? ` (resolved from "${u.offer_id}")` : ""}\n${u.patches.map(p => `   ${p.op} ${p.path}${p.value !== undefined ? ` = ${JSON.stringify(p.value)}` : ""}`).join("\n")}`).join("\n\n")}${resolvedUpdates.length > 5 ? `\n\n... (${resolvedUpdates.length - 5} more)` : ""}

This will PATCH ${resolvedUpdates.length} offer-items.${endIdx < totalUpdates ? `\n\n⚠️ You supplied ${totalUpdates} updates but only ${limit} will be processed this call. After confirming, you'll get a "call again with offset:${endIdx}" hint to continue.` : ""}`);
      if (check) return check;

      const SOFT_DEADLINE_MS = 45_000;
      const t0 = Date.now();
      const results = [], errors = [];
      let stopped = false;
      for (let i = 0; i < resolvedUpdates.length; i += chunk_size) {
        if (Date.now() - t0 > SOFT_DEADLINE_MS) { stopped = true; break; }
        const chunk = resolvedUpdates.slice(i, i + chunk_size);
        const settled = await Promise.all(chunk.map(async (u) => {
          const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items/${u.resolvedId}`, "PATCH", offerItemHeaders(token, cfg), u.patches);
          return { id: u.resolvedId, res };
        }));
        for (const { id, res } of settled) {
          if (res.ok) results.push(id);
          else        errors.push({ id, error: JSON.stringify(res.body).slice(0, 200) });
        }
      }

      const processed  = results.length + errors.length;
      const nextOffset = startIdx + processed;
      const hasMore    = nextOffset < totalUpdates;
      const wallSecs   = ((Date.now() - t0) / 1000).toFixed(1);

      return { content: [{ type: "text", text:
`📦 BULK OFFER UPDATE ${stopped ? "PARTIAL (soft time budget reached)" : "COMPLETE"}
Window   : ${windowLabel}
Processed: ${processed} in ${wallSecs}s   ✅ ${results.length} updated   ❌ ${errors.length} failed
${results.length <= 20 ? results.map(id => `  ✅ ${id}`).join("\n") : results.slice(0, 10).map(id => `  ✅ ${id}`).join("\n") + `\n  ... (${results.length - 20} more) ...\n` + results.slice(-10).map(id => `  ✅ ${id}`).join("\n")}
${errors.length ? `\nErrors:\n${errors.slice(0, 5).map(e => `  ❌ ${e.id} → ${e.error}`).join("\n")}${errors.length > 5 ? `\n  ... (${errors.length - 5} more errors)` : ""}` : ""}

${hasMore
  ? `⏭️  ${totalUpdates - nextOffset} updates remaining. Call bulk_update_offers again with:\n     offset: ${nextOffset}  (and same updates array, confirmed: true)\n`
  : `✅ All ${totalUpdates} updates processed.`}` }] };
    })
  );

  // ════════ TOOL 43 — bulk_delete_offers ═══════════════════════════════════════
  server.tool("bulk_delete_offers",
    `Permanently delete multiple offer items in one call. Requires confirmed: true. This cannot be undone — prefer bulk_update_offers (patch /_experience/decisioning/offeritem/lifecycleStatus to "archived") if you may want them back. Supports pagination via offset/limit: each call processes at most 30 deletes to stay under Adobe I/O Runtime's 60s cap, then returns a "call again with offset:X" instruction the LLM chains automatically.`,
    {
      offer_ids:    z.array(z.string()).min(1).describe("Offer item IDs or exact offer names to delete."),
      confirmed:    boolish(),
      offset:       z.number().int().min(0).default(0).describe("Skip this many IDs before processing. Use for pagination on big deletes."),
      limit:        z.number().int().min(1).max(60).default(30).describe("Process at most this many IDs in this call. Default 30 (safely fits Adobe's 60s function cap given delete latency + jittered 409 retries)."),
      chunk_size:   z.number().int().min(1).max(10).default(5).describe("How many DELETEs to issue in parallel per chunk. Default 5. Higher risks catalog write-lock 409s (auto-retried) and Runtime timeouts."),
      access_token: z.string().optional(),
    },
    wrap(async ({ offer_ids, confirmed, offset, limit, chunk_size, access_token }) => {
      const { cfg, token } = await requireApiConfig({ access_token });

      const offerResolve = await resolveOfferIdentifiers(offer_ids, token, cfg);
      if (offerResolve.error) return { content: [{ type: "text", text: `❌ Could not resolve offer_ids: ${offerResolve.error}` }] };
      const allIds = offerResolve.ids;

      const totalIds  = allIds.length;
      const startIdx  = Math.min(offset, totalIds);
      const endIdx    = Math.min(offset + limit, totalIds);
      const idsWindow = allIds.slice(startIdx, endIdx);
      const windowLabel = `IDs ${startIdx + 1}-${endIdx} of ${totalIds}`;

      const check = await needsConfirmation(server, confirmed,
`OFFERS TO DELETE: ${idsWindow.length} (window: ${windowLabel})
Sandbox : ${cfg.SANDBOX_NAME}

${idsWindow.slice(0, 10).map((id, i) => `  ${startIdx + i + 1}. ${id}`).join("\n")}${idsWindow.length > 10 ? `\n  ... (${idsWindow.length - 10} more)` : ""}

⚠️  This cannot be undone. Prefer bulk_update_offers (patch lifecycleStatus="archived") if you may want these back.${endIdx < totalIds ? `\n\n⚠️ You supplied ${totalIds} IDs but only ${limit} will be processed this call. After confirming, you'll get a "call again with offset:${endIdx}" hint to continue.` : ""}

This will DELETE ${idsWindow.length} offer-items.`);
      if (check) return check;

      // Soft deadline so we return partial results gracefully instead of being
      // killed at Runtime's 60s cap. 409 catalog-conflict retries can add ~2s
      // per failed request, so we budget conservatively.
      const SOFT_DEADLINE_MS = 45_000;
      const t0 = Date.now();
      const results = [], errors = [];
      let stopped = false;
      for (let i = 0; i < idsWindow.length; i += chunk_size) {
        if (Date.now() - t0 > SOFT_DEADLINE_MS) { stopped = true; break; }
        const chunk = idsWindow.slice(i, i + chunk_size);
        const settled = await Promise.all(chunk.map(async (id) => {
          const res = await apiCall(`${DEFAULTS.BASE_DPS_URL}/offer-items/${id}`, "DELETE", offerItemHeaders(token, cfg));
          return { id, res };
        }));
        for (const { id, res } of settled) {
          if (res.ok) results.push(id);
          else        errors.push({ id, error: JSON.stringify(res.body).slice(0, 200) });
        }
      }

      const processed  = results.length + errors.length;
      const nextOffset = startIdx + processed;
      const hasMore    = nextOffset < totalIds;
      const wallSecs   = ((Date.now() - t0) / 1000).toFixed(1);

      return { content: [{ type: "text", text:
`📦 BULK OFFER DELETE ${stopped ? "PARTIAL (soft time budget reached)" : "COMPLETE"}
Window   : ${windowLabel}
Processed: ${processed} in ${wallSecs}s   ✅ ${results.length} deleted   ❌ ${errors.length} failed
${results.length <= 20 ? results.map(id => `  ✅ ${id}`).join("\n") : results.slice(0, 10).map(id => `  ✅ ${id}`).join("\n") + `\n  ... (${results.length - 20} more) ...\n` + results.slice(-10).map(id => `  ✅ ${id}`).join("\n")}
${errors.length ? `\nErrors:\n${errors.slice(0, 5).map(e => `  ❌ ${e.id} → ${e.error}`).join("\n")}${errors.length > 5 ? `\n  ... (${errors.length - 5} more errors)` : ""}` : ""}

${hasMore
  ? `⏭️  ${totalIds - nextOffset} IDs remaining. Call bulk_delete_offers again with:\n     offset: ${nextOffset}  (and same offer_ids array, confirmed: true)\n`
  : `✅ All ${totalIds} IDs processed.`}` }] };
    })
  );

  // ════════ TOOL 44 — attach_offer_eligibility_rule ════════════════════════════
  server.tool("attach_offer_eligibility_rule",
    `Attach (or remove) offer-level eligibility directly on one or more offer items — independent of any selection strategy. Choose exactly one of: a decision/eligibility rule, an audience, or neither (to detach). Sets/clears offer._experience.decisioning.decisionitem.itemConstraints. Works for a single offer (pass one ID or name) or many at once. Requires confirmed: true to execute.`,
    {
      offer_ids:           z.array(z.string()).min(1).describe("Offer item ID(s) or exact offer name(s) to attach eligibility to, or remove it from. Names are resolved automatically; a name matching more than one offer fails with an error listing the matches so you can specify by ID instead."),
      eligibility_rule_id: z.string().optional().describe(`Decision/eligibility rule ID or exact rule name to attach. Mutually exclusive with audience. Omit both to detach any existing offer-level eligibility (resets itemConstraints to profileConstraintType: "none"). Names are resolved automatically; an ambiguous name fails with an error listing the matches.`),
      audience:            z.string().optional().describe(`Audience (Real-Time CDP segment) ID or exact name to restrict eligibility to. Mutually exclusive with eligibility_rule_id. Audiences are a separate resource from eligibility rules — under the hood this attaches an auto-generated eligibility rule (named "Audience: <name>", reused on repeat calls rather than duplicated) that checks segment membership.`),
      confirmed:           boolish(),
      access_token:        z.string().optional(),
    },
    wrap(async ({ offer_ids, eligibility_rule_id, audience, confirmed, access_token }) => {
      if (eligibility_rule_id && audience)
        return { content: [{ type: "text", text: "❌ Provide only one of eligibility_rule_id or audience, not both." }] };

      const { cfg, token } = await requireApiConfig({ access_token });

      const offerResolve = await resolveOfferIdentifiers(offer_ids, token, cfg);
      if (offerResolve.error)
        return { content: [{ type: "text", text: `❌ Could not resolve offer_ids: ${offerResolve.error}` }] };
      const resolvedOfferIds = offerResolve.ids;

      let resolvedRuleId = null, ruleName = null, audienceInfo = null;
      if (eligibility_rule_id) {
        const ruleResolve = await resolveEligibilityRuleIdentifier(eligibility_rule_id, token, cfg);
        if (ruleResolve.error)
          return { content: [{ type: "text", text: `❌ Could not resolve eligibility_rule_id: ${ruleResolve.error}` }] };
        resolvedRuleId = ruleResolve.id;
        ruleName = ruleResolve.name;
      } else if (audience) {
        // Read-only lookup here only — the underlying eligibility rule (a
        // real write) isn't created/reused until after confirmed:true below.
        const audienceResolve = await resolveAudienceIdentifier(audience, token, cfg);
        if (audienceResolve.error)
          return { content: [{ type: "text", text: `❌ Could not resolve audience: ${audienceResolve.error}` }] };
        audienceInfo = audienceResolve;
      }

      const actionLabel = resolvedRuleId
        ? `ATTACH eligibility rule "${ruleName}" (${resolvedRuleId})`
        : audienceInfo
        ? `ATTACH audience "${audienceInfo.name}" (${audienceInfo.id}) — will create/reuse eligibility rule "Audience: ${audienceInfo.name}"`
        : `DETACH any offer-level eligibility (reset to no constraint)`;

      const check = await needsConfirmation(server, confirmed,
`${actionLabel}
Offers  : ${resolvedOfferIds.length}
Sandbox : ${cfg.SANDBOX_NAME}

${resolvedOfferIds.map((id, i) => `  ${i + 1}. ${id}${offer_ids[i] !== id ? ` (resolved from "${offer_ids[i]}")` : ""}`).join("\n")}

This will PATCH ${resolvedOfferIds.length} offer-item(s)' itemConstraints.`);
      if (check) return check;

      let audienceNote = "";
      if (audienceInfo) {
        const ensured = await ensureAudienceEligibilityRule(audienceInfo.id, audienceInfo.name, token, cfg);
        if (ensured.error)
          return { content: [{ type: "text", text: `❌ Could not attach audience: ${ensured.error}` }] };
        resolvedRuleId = ensured.id;
        ruleName = ensured.name;
        audienceNote = `\nEligibility rule "${ruleName}" (${resolvedRuleId}) — ${ensured.reused ? "reused existing" : "newly created"}.`;
      }

      const itemConstraints = resolvedRuleId
        ? { profileConstraintType: "eligibilityRule", eligibilityRule: resolvedRuleId }
        : { profileConstraintType: "none" };

      const { results, errors } = await runChunked(resolvedOfferIds, async (id) => {
        const res = await apiCall(
          `${DEFAULTS.BASE_DPS_URL}/offer-items/${id}`, "PATCH", offerItemHeaders(token, cfg),
          [{ op: "replace", path: "/_experience/decisioning/decisionitem/itemConstraints", value: itemConstraints }]
        );
        return { id, res };
      });

      return { content: [{ type: "text", text:
`📦 ${resolvedRuleId ? "ELIGIBILITY ATTACHED" : "ELIGIBILITY DETACHED"}
✅ Succeeded : ${results.length}  |  ❌ Failed: ${errors.length}
${results.map(id => `  ✅ ${id}`).join("\n")}
${errors.length ? `\nErrors:\n${errors.map(e => `  ❌ ${e.id} → ${e.error}`).join("\n")}` : ""}${audienceNote}` }] };
    })
  );

  return server;
}
