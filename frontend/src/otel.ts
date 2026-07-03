/**
 * Optional OpenTelemetry Web bootstrap — the frontend half of `backend/src/otel.ts`.
 *
 * Off by default (spans stay no-ops, zero bundle cost beyond `@opentelemetry/api`).
 * Set `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. in `frontend/.env.local`) to turn it
 * on: it registers a `WebTracerProvider` with an OTLP/HTTP exporter, plus
 * fetch/document-load auto-instrumentation, and wires `window.onerror` /
 * `unhandledrejection` to `log.error` + a recorded exception span so uncaught
 * frontend errors show up in the same trace backend as `pnpm trace` does for the
 * daemon (see `docs/decisions/observability.md`).
 *
 * The optional SDK packages are dynamically imported so a plain `pnpm dev` build
 * never pulls them into the bundle.
 */

import { log } from '@/lib/log'

const endpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT as string | undefined

export async function initOtel(): Promise<void> {
  installGlobalErrorHandlers()

  if (!endpoint) return

  try {
    const [{ WebTracerProvider, BatchSpanProcessor, StackContextManager }, { OTLPTraceExporter }, { resourceFromAttributes }, { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION }, { registerInstrumentations }, { FetchInstrumentation }, { DocumentLoadInstrumentation }] =
      await Promise.all([
        import('@opentelemetry/sdk-trace-web'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/semantic-conventions'),
        import('@opentelemetry/instrumentation'),
        import('@opentelemetry/instrumentation-fetch'),
        import('@opentelemetry/instrumentation-document-load'),
      ])

    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: import.meta.env.VITE_OTEL_SERVICE_NAME ?? 'ai-storm-frontend',
        [ATTR_SERVICE_VERSION]: '3.0.0',
      }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))],
    })
    provider.register({ contextManager: new StackContextManager() })

    registerInstrumentations({
      instrumentations: [
        new FetchInstrumentation({ propagateTraceHeaderCorsUrls: /.*/ }),
        new DocumentLoadInstrumentation(),
      ],
    })

    log.info('otel.started', { endpoint })
  } catch (err) {
    log.warn('otel.unavailable', { error: err instanceof Error ? err.message : String(err) })
  }
}

let installed = false

function installGlobalErrorHandlers(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    log.error('frontend.uncaught_error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    log.error('frontend.unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  })
}
