/**
 * Structured logging + tracing for the backend flow.
 *
 *   1. `log.{debug,info,warn,error}` — structured records, level set in code via
 *      the `LOG_LEVEL` constant below (debug|info|warn|error). Printed as
 *      human-readable lines; also attached as events to the active OTel span.
 *   2. `withSpan` / `addEvent` — real OTel spans via `@opentelemetry/api`. The
 *      API is a no-op unless a tracer provider is registered, so there is zero
 *      overhead when tracing is off. Run `pnpm trace` (or `node --import
 *      ./src/otel.ts ...`) to register the OTLP exporter (see otel.ts).
 */

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

type AttrValue = string | number | boolean;
type Attrs = Record<string, AttrValue | undefined>;
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Active log level — edit this to see/hide lower-severity records. */
const LOG_LEVEL: Level = "debug";
const THRESHOLD = LEVELS[LOG_LEVEL];

const tracer = trace.getTracer("ai-storm-backend", "3.0.0");

function clean(attrs?: Attrs): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function emit(level: Level, event: string, attrs?: Attrs): void {
  if (LEVELS[level] < THRESHOLD) return;
  const a = clean(attrs);

  const active = trace.getActiveSpan();
  if (active) active.addEvent(event, a);

  const ts = new Date().toISOString();
  const tail = Object.keys(a).length ? " " + JSON.stringify(a) : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${event}${tail}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, attrs?: Attrs) => emit("debug", event, attrs),
  info: (event: string, attrs?: Attrs) => emit("info", event, attrs),
  warn: (event: string, attrs?: Attrs) => emit("warn", event, attrs),
  error: (event: string, attrs?: Attrs) => emit("error", event, attrs),
};

/** Add a point-in-time event to the currently active span. */
export function addEvent(name: string, attrs?: Attrs): void {
  trace.getActiveSpan()?.addEvent(name, clean(attrs));
}

/** Run `fn` inside a new active span, recording errors and ending it. */
export async function withSpan<T>(
  name: string,
  attrs: Attrs,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(clean(attrs))) span.setAttribute(k, v);
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
