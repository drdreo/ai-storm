/**
 * Optional OpenTelemetry Web bootstrap — the frontend half of `backend/src/otel.ts`.
 *
 * Uses the standard shipped browser instrumentations
 * (https://github.com/open-telemetry/opentelemetry-browser) instead of hand-rolled
 * `window.onerror`/console wiring: `ConsoleInstrumentation` turns every
 * `console.{log,warn,error,info,debug}` call into an OTel log record, and
 * `ErrorsInstrumentation` does the same for uncaught errors and unhandled promise
 * rejections. Both are always registered, so `log.ts`'s console calls and any
 * uncaught error are captured — but they're no-ops without a registered
 * `LoggerProvider`, so this costs nothing until an OTLP endpoint is configured.
 *
 * Set `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. in `frontend/.env.local`) to
 * additionally register a `LoggerProvider` + `TracerProvider` with OTLP/HTTP
 * exporters, matching `pnpm trace` on the backend (see
 * `docs/design/observability.md`).
 *
 * Every package here is an `optionalDependency`, dynamically imported, so a
 * plain `pnpm dev`/`pnpm build` never pulls any of it into the bundle unless this
 * code path actually runs.
 */

const endpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT as string | undefined
const serviceName = (import.meta.env.VITE_OTEL_SERVICE_NAME as string | undefined) ?? 'ai-storm-frontend'

export async function initOtel(): Promise<void> {
  try {
    const [{ ConsoleInstrumentation }, { ErrorsInstrumentation }, { registerInstrumentations }] =
      await Promise.all([
        import('@opentelemetry/browser-instrumentation/experimental/console'),
        import('@opentelemetry/browser-instrumentation/experimental/errors'),
        import('@opentelemetry/instrumentation'),
      ])

    if (endpoint) await registerExporters()

    registerInstrumentations({
      instrumentations: [new ConsoleInstrumentation(), new ErrorsInstrumentation()],
    })
  } catch (err) {
    console.warn('otel.unavailable', err instanceof Error ? err.message : String(err))
  }
}

/** Wire up OTLP/HTTP exporters for logs (console + errors) and traces (`withSpan`). */
async function registerExporters(): Promise<void> {
  const [
    { logs },
    { LoggerProvider, BatchLogRecordProcessor },
    { OTLPLogExporter },
    { WebTracerProvider, BatchSpanProcessor, StackContextManager },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import('@opentelemetry/api-logs'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/exporter-logs-otlp-http'),
    import('@opentelemetry/sdk-trace-web'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ])

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: '3.0.0',
  })

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }) }),
    ],
  })
  logs.setGlobalLoggerProvider(loggerProvider)

  const tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))],
  })
  tracerProvider.register({ contextManager: new StackContextManager() })
}
