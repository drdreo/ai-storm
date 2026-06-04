/**
 * Structured logging + tracing for the backend flow.
 *
 * Two layers, both wired to Deno's built-in OpenTelemetry:
 *   1. `log.{debug,info,warn,error}` — structured records. When the process is
 *      started with `OTEL_DENO=1`, Deno automatically captures `console.*`
 *      output as OTel log records and ships them over OTLP; otherwise they are
 *      printed as human-readable lines. Level is controlled by `AI_STORM_LOG`
 *      (debug|info|warn|error, default info).
 *   2. `withSpan` / `addEvent` — real OTel spans via `@opentelemetry/api`. With
 *      `OTEL_DENO=1` these export as a trace tree (and nest under the automatic
 *      `Deno.serve` request spans); without it the API is a no-op, so there is
 *      zero overhead when tracing is off.
 *
 * Run with tracing:  deno task trace   (or set OTEL_DENO=1 yourself)
 * Point at a collector:  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 */

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

type AttrValue = string | number | boolean;
type Attrs = Record<string, AttrValue | undefined>;
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(Deno.env.get("AI_STORM_LOG") as Level) ?? "info"] ?? LEVELS.info;

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

  // Attach the message to the current span (if any) so logs correlate to the
  // trace tree when OTEL_DENO is enabled.
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
