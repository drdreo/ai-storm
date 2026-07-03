/**
 * Structured logging + tracing for the frontend flow — mirrors
 * `backend/src/log.ts` so the two halves read the same way in a combined trace.
 *
 *   1. `log.{debug,info,warn,error}` — structured records, printed as
 *      human-readable console lines and attached as events to the active OTel
 *      span (if any is active).
 *   2. `withSpan` / `addEvent` — real OTel spans via `@opentelemetry/api`. The
 *      API is a no-op unless a tracer provider is registered, so this has zero
 *      overhead until `initOtel()` (see `otel.ts`) turns tracing on.
 */

import { type Span, SpanStatusCode, trace } from '@opentelemetry/api'

type AttrValue = string | number | boolean
type Attrs = Record<string, AttrValue | undefined>
type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Active log level — 'debug' in dev builds, 'info' otherwise. */
const LOG_LEVEL: Level = import.meta.env.DEV ? 'debug' : 'info'
const THRESHOLD = LEVELS[LOG_LEVEL]

const tracer = trace.getTracer('ai-storm-frontend', '3.0.0')

function clean(attrs?: Attrs): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {}
  if (!attrs) return out
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function emit(level: Level, event: string, attrs?: Attrs): void {
  if (LEVELS[level] < THRESHOLD) return
  const a = clean(attrs)

  const active = trace.getActiveSpan()
  if (active) active.addEvent(event, a)

  const line = `${event}`
  if (level === 'error') console.error(line, a)
  else if (level === 'warn') console.warn(line, a)
  else if (level === 'debug') console.debug(line, a)
  else console.log(line, a)
}

export const log = {
  debug: (event: string, attrs?: Attrs) => emit('debug', event, attrs),
  info: (event: string, attrs?: Attrs) => emit('info', event, attrs),
  warn: (event: string, attrs?: Attrs) => emit('warn', event, attrs),
  error: (event: string, attrs?: Attrs) => emit('error', event, attrs),
}

/** Add a point-in-time event to the currently active span. */
export function addEvent(name: string, attrs?: Attrs): void {
  trace.getActiveSpan()?.addEvent(name, clean(attrs))
}

/** Run `fn` inside a new active span, recording errors and ending it. */
export async function withSpan<T>(
  name: string,
  attrs: Attrs,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(clean(attrs))) span.setAttribute(k, v)
      return await fn(span)
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      throw err
    } finally {
      span.end()
    }
  })
}

/** Record an exception on the active span (if any) without ending it. */
export function recordException(err: unknown): void {
  const active = trace.getActiveSpan()
  if (!active) return
  active.recordException(err instanceof Error ? err : new Error(String(err)))
  active.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
}
