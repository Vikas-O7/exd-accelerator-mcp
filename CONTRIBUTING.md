# Contributing

Thanks for hacking on the ExD Accelerator MCP. Quick guide for getting set up.

## Dev loop

```bash
git clone https://github.com/Vikas-O7/exd-accelerator-mcp.git
cd exd-accelerator-mcp
npm install
cp .env.example .env       # fill in CLIENT_ID, CLIENT_SECRET, sandbox, schema, catalog
npm run smoke              # stdio + local-HTTP smoke test, hits real Adobe APIs
```

If you don't have Adobe credentials, run `npm run smoke:ci` instead — it skips
every check that calls Adobe Platform APIs and exercises only the MCP protocol +
no-network tools (`parse_csv_and_suggest`, dry-run, confirmation guard).

## Layout

| Path | Purpose |
|---|---|
| `src/server.js` | `buildMcpServer(config)` factory + all 21 tools. The only file you usually touch. |
| `src/stdio.js` | Entry point for Claude Desktop (and other stdio MCP clients) |
| `src/http-local.js` | Local Node http server that mimics the Vercel route. `npm run dev:http` |
| `api/mcp.js` | Vercel serverless route — Streamable HTTP transport |
| `api/health.js` | Vercel liveness probe |
| `scripts/smoke.js` | Smoke test driver, exercises both transports |
| `vercel.json` | Explicit `builds` and `routes` — without this, Vercel auto-detects `src/server.js` as a single root function (wrong) |

## Adding a new MCP tool

Inside `buildMcpServer` in `src/server.js`:

```js
server.tool("my_tool_name",
  "Short description shown to the LLM. Mention 'requires confirmed: true' if it's a write.",
  {
    // Zod schema for arguments
    some_arg: z.string().describe("..."),
    confirmed: z.boolean().default(false),  // include for writes
    access_token: z.string().optional(),    // include for tools that hit Adobe APIs
  },
  wrap(async ({ some_arg, confirmed, access_token }) => {
    // For tools that hit Adobe APIs:
    const { cfg, token } = await requireApiConfig({ access_token });

    // For write tools, gate behind confirmation:
    const check = needsConfirmation(confirmed, `What this will do...`);
    if (check) return check;

    const res = await apiCall(url, "POST", dpsHeaders(token, cfg), body);
    return { content: [{ type: "text", text: "..." }] };
  })
);
```

Then increment the tool count expectation in `scripts/smoke.js` (search for `21`).

## Commit conventions

- One logical change per commit
- Subject in imperative present tense ("add X", not "added X")
- Reference the area in the prefix when useful: `fix(vercel): ...`, `feat(tools): ...`, `docs: ...`

## Vercel deploy quirks

- **Commits must be authored by a GitHub user that's linked to a Vercel team member.** If your commits get stuck in "Blocked" status, check `git config user.email` — it must match a verified email on a GitHub account linked to the Vercel account that owns the project.
- **`vercel.json` must declare `builds` and `routes` explicitly.** Without them, Vercel auto-detects `src/server.js` as a single root function and the `api/` directory is ignored.
- **Don't commit `.vercel/`.** It's gitignored. The CLI re-creates it on `vercel pull`.

## PR checklist

- [ ] `npm run smoke` passes locally
- [ ] If you added a tool, smoke test expectations updated
- [ ] README updated if the tool list or workflow changed
- [ ] No `console.log` (use `console.error` — stdout is reserved for MCP JSON-RPC)
- [ ] No secrets in commits — `.env` stays gitignored
