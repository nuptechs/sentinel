# Sentinel — AI Agent Guidelines

## Overview

QA capture → AI diagnosis → code correction pipeline. Hexagonal architecture with 7 ports. Integrates AI diagnosis (Claude), backend tracing (Debug Probe), code analysis (Manifest), and external issue trackers (GitHub, Linear, Jira).

See `ARCHITECTURE.md` for full system design.

## Tech Stack (Firmly Decided)

| Layer | Technology |
|-------|-----------|
| Runtime | Node 20+ ESM (pure JavaScript, no TypeScript) |
| Server | Express 5 |
| Database | PostgreSQL (optional, Memory adapter for dev) |
| AI | Anthropic Claude |
| Testing | Node.js built-in test runner (`node --test`) |
| Validation | Zod |
| Deploy | Railway + Docker |

## Project Structure

```
src/
  core/
    domain/          ← Session, Finding, CaptureEvent entities
    ports/           ← 7 port abstractions
    services/        ← SessionService, FindingService, DiagnosisService, etc.
    errors.js        ← SentinelError, ValidationError, NotFoundError, etc.
  adapters/
    storage/         ← PostgreSQL, Memory
    ai/              ← Claude
    trace/           ← DebugProbe, Noop
    analyzer/        ← Manifest, Noop
    notification/    ← Webhook (HMAC-SHA256), Noop
    issue-tracker/   ← GitHub, Linear, Jira, Noop
    capture/         ← Noop
  server/
    app.js           ← Express app factory
    index.js         ← Server entry point
    middleware/       ← request-id, api-key, rate-limiter, error-handler
    routes/          ← sessions, findings, projects
  mcp/               ← Model Context Protocol server (Stdio + SSE)
  sdk/               ← Browser SDK (reporter, recorder, annotator)
  container.js       ← DI container (ports → adapters → services)
  index.js           ← Public API exports
tests/               ← Mirrors src/ structure
```

## Port/Adapter Pattern (7 Ports)

| Port | Adapters | Env Var Selection |
|------|----------|-------------------|
| StoragePort | PostgreSQL, Memory | `DATABASE_URL` or `SENTINEL_MEMORY_STORAGE=true` |
| AIPort | Claude | `ANTHROPIC_API_KEY` |
| TracePort | DebugProbe, Noop | `DEBUG_PROBE_URL` |
| AnalyzerPort | Manifest, Noop | `MANIFEST_URL` + `MANIFEST_API_KEY` |
| NotificationPort | Webhook, Noop | `WEBHOOK_URL` + `WEBHOOK_SECRET` |
| IssueTrackerPort | GitHub, Linear, Jira, Noop | `SENTINEL_GITHUB_TOKEN`, etc. |
| CapturePort | Noop | — |

### Container Pattern (DI)
All wiring is in `src/container.js`. Adapter selection is driven by environment variables. Call `getContainer()` for the singleton.

### Adding a New Adapter
1. Create adapter in `src/adapters/<port-name>/<adapter>.adapter.js`
2. Implement all methods from the corresponding port
3. Add env-var-based selection in `src/container.js`
4. Add Noop adapter as fallback

## Domain Entities

### Finding Status Flow
```
open → diagnosed → fix_proposed → fix_applied → verified
                                               → dismissed
```

### Finding Sources
- `manual` (human annotation via SDK overlay)
- `auto_error`, `auto_performance`, `auto_network` (auto-detected)

## API Endpoints (port 7070)

**Sessions:** `POST /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions`, `POST /api/sessions/:id/complete`, `GET /api/sessions/:id/replay`

**Findings:** `POST /api/findings`, `GET /api/findings/:id`, `GET /api/findings`, `POST /api/findings/:id/diagnose`, `POST /api/findings/:id/correct`, `POST /api/findings/:id/clarify`, `POST /api/findings/:id/dismiss`, `POST /api/findings/:id/apply`, `POST /api/findings/:id/verify`, `POST /api/findings/:id/push`, `POST /api/findings/:id/suggest-title`

**MCP:** `POST /mcp` (Streamable HTTP), `GET /sse` (SSE), `POST /messages`

## Coding Conventions

- **Pure JavaScript ESM** — no TypeScript, `"type": "module"`
- **Port contracts** — abstract classes with `throw new Error('not implemented')`
- **Semantic error classes** — `SentinelError > ValidationError | NotFoundError | ConflictError | IntegrationError`
- **Noop adapters** — every port has a no-op fallback for when the dependency isn't configured

## Build & Test

```bash
npm run dev              # node --watch src/server/index.js
npm test                 # node --test tests/**/*.test.js
npm run test:coverage    # With v8 coverage
npm run lint             # eslint src/
npm run mcp              # Start MCP server
```

## Browser SDK

- `sdk/reporter.js` — batch event reporting to server
- `sdk/recorder.js` — rrweb integration for session replay
- `sdk/annotator.js` — bug overlay UI + element screenshot + AI title annotation
