# Design: Baseline observability with OpenTelemetry

**Status:** 🟢 Implemented (baseline)
**Author:** ai-storm
**Related:** issue #133 · [`README.md`](../../README.md) §"Logging & tracing" · `backend/src/log.ts` /
`backend/src/otel.ts` · `frontend/src/lib/log.ts` / `frontend/src/otel.ts`

---

## 1. Problem statement

ai-storm is local-first and never hosted (PRD §1), so there is no shared APM account or
cloud dashboard to point a user at. Debugging a stuck PTY attach, a dropped WebSocket, or a
frontend crash today means reading raw `console.log` output — there is no structured, correlated
view of a request as it crosses the WebSocket boundary between the tab and the daemon.

The bar for this issue is deliberately a **baseline**: structured logs and OTel spans/exceptions on
both halves, off by default, and a documented (not yet vendored) recommendation for a local
visualizer — not a hosted observability stack.

## 2. What's instrumented

Both halves share the same shape, so a trace reads the same way regardless of which side emitted
it:

- `log.{debug,info,warn,error}(event, attrs)` — structured, human-readable console lines. Each call
  also attaches an event to the currently active OTel span, so log lines show up inline in a trace
  viewer even without a dedicated log pipeline.
- `withSpan(name, attrs, fn)` — wraps `fn` in a real OTel span (`tracer.startActiveSpan`), records
  thrown errors via `recordException` + `SpanStatusCode.ERROR`, and always ends the span.
- `addEvent(name, attrs)` / `recordException(err)` — point-in-time additions to whatever span is
  currently active.

`@opentelemetry/api` is a normal (always-installed) dependency on both sides; the API is a no-op
until a tracer provider is registered, so none of the call sites above cost anything unless tracing
is explicitly turned on. The SDK/exporter packages that *do* register a provider are
`optionalDependencies`, dynamically imported, and wrapped in try/catch — a missing or failed import
degrades to "logs only, no exported spans" rather than crashing the app.

### Backend (`backend/src/log.ts`, `backend/src/otel.ts`)

- Already covered the daemon's key paths before this issue: `ws.open/close/error`,
  `attach.request/setup/ready/error`, `resolve.candidates/chosen`, `pty.spawned/data/exit`,
  `input`/`input.flush_buffered`/`input.dropped`, `agent.dispatch/spawned/exit`, and the
  process-level `unhandledRejection`/`uncaughtException` guards in `main.ts`.
- `pnpm trace` (`node --import ./src/otel.ts src/main.ts`) registers a `NodeSDK` with an OTLP/HTTP
  trace exporter; `OTEL_EXPORTER_OTLP_ENDPOINT` points it at a collector (defaults to
  `http://localhost:4318`).

### Frontend (`frontend/src/lib/log.ts`, `frontend/src/otel.ts`)

New for this issue:

- `initOtel()` runs once at boot (`main.tsx`). It always installs `window.onerror` and
  `window.onunhandledrejection` handlers that call `log.error` (`frontend.uncaught_error` /
  `frontend.unhandled_rejection`) with message/stack, and record the exception on the active span
  if one exists — this is the "frontend errors are reported" acceptance criterion.
- If `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` is set, it additionally registers a `WebTracerProvider`
  (OTLP/HTTP exporter, `BatchSpanProcessor`) plus `FetchInstrumentation` and
  `DocumentLoadInstrumentation`, so the boot-time document load and any `fetch` calls (e.g. the
  `/health` probe) become spans automatically. Left unset, the whole SDK bootstrap is skipped.
- Instrumented paths: `workspace.boot` (the CRDT registry rehydrate + starter-workspace flow) as a
  span, WebSocket lifecycle (`ws.open/close/error`) in `backend.store.ts`, agent-run errors
  (`agent.run_error`) in `agent.store.ts`, and the boot-failure path in `App.tsx`.

Set `VITE_OTEL_SERVICE_NAME` to override the reported `service.name` (defaults to
`ai-storm-frontend`); create `frontend/.env.local` to set either var for local dev (Vite loads
`.env.local` automatically and it's git-ignored).

## 3. Local-first visualizer evaluation

The daemon and the tab both speak standard OTLP/HTTP (port 4318 by default), so any collector that
accepts OTLP works without touching app code. Candidates evaluated, all self-hostable and free of
a required cloud account:

| Option | Footprint | Traces | Logs | Verdict |
| --- | --- | --- | --- | --- |
| **Jaeger (all-in-one, v2)** | 1 container, in-memory or badger storage | ✅ native OTLP ingest | ➖ (traces only) | **Recommended.** `docker run -p 4318:4318 -p 16686:16686 jaegertracing/jaeger:2.x` and you have a trace UI in under a minute — closest thing to zero-config for a project this size. |
| **Grafana Tempo + Loki + Grafana** | 3+ containers, needs a `docker-compose.yml` + provisioned datasources | ✅ | ✅ (via Loki, separate pipeline) | Most complete picture (traces *and* logs, correlated), but config weight is disproportionate to "baseline" — worth revisiting once frontend/backend logs need to be queried, not just eyeballed in a trace. |
| **SigNoz** | Single docker-compose stack (ClickHouse-backed) | ✅ | ✅ | Genuinely local-first (self-hosted, OSS core) and gives traces+logs+metrics in one UI, but the ClickHouse dependency is heavier than this project needs for a first pass. Good next step if Tempo/Loki proves too fiddly. |
| **otel-desktop-viewer** | Single static binary, no Docker | ✅ | ➖ | Interesting for a *dependency-free* option (matches the "local-first" spirit — no daemon to manage beyond the app itself), but less mature/maintained than Jaeger; keep as a fallback. |
| **Hosted APM (Honeycomb, Datadog, etc.)** | N/A | — | — | Ruled out per the issue: this app never phones home, and a hosted vendor would be the one external dependency the whole product goes out of its way to avoid. |

**Recommendation:** start with **Jaeger all-in-one** as the default local collector — one
container, native OTLP/HTTP ingest on 4318, a trace UI on 16686, nothing to provision. It only
covers traces (not the structured logs), but since both `log.ts` implementations already attach
log events onto the active span, most of what you'd want from "logs" shows up inline in the Jaeger
trace view anyway. If/when correlated log search across long-running sessions becomes a real need,
revisit Grafana Tempo+Loki or SigNoz.

Actually vendoring a `docker-compose.yml` for Jaeger (or documenting the exact run command as a
`pnpm` script) is left as follow-up work, per the issue ("will be added to repo later").

## 4. Non-goals

- Metrics (counters/gauges) — spans + log events cover the "what happened and how long did it
  take" need; nothing in the current codebase needs numeric aggregation yet.
- Sampling/rate-limiting — traffic volume here is one developer's local session, not production
  load; every span is exported when tracing is on.
- Auto-instrumenting the WebSocket transport itself — `@opentelemetry/instrumentation-fetch` covers
  `fetch`, but there's no mature browser WS auto-instrumentation; the manual `ws.*` log events in
  `backend.store.ts` cover the same events by hand.
