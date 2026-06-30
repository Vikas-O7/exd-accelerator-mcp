## Summary

<!-- What changed and why -->

## Test plan

- [ ] `npm run smoke` passes locally (or `npm run smoke:ci` if no Adobe creds)
- [ ] New tool added? → smoke expectations updated (21 → N+1)
- [ ] README updated if tool list or workflow changed
- [ ] No `console.log` (stdout is reserved for MCP JSON-RPC; use `console.error`)
- [ ] No secrets committed

## Deploy notes

<!-- Anything reviewers should know about the Vercel side, env vars, schema changes, etc. -->
