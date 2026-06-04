/**
 * Optional OpenTelemetry bootstrap.
 *
 * Loaded via `node --import ./src/otel.ts ...` (the `pnpm trace` script). Starts
 * the Node SDK with an OTLP/HTTP trace exporter so the `pty.attach` spans and
 * log events from log.ts are exported. Configure the collector with the
 * standard env var, e.g. OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318.
 *
 * Everything is wrapped defensively: if the optional SDK packages aren't
 * installed, the process still runs (spans become no-ops).
 */

try {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "ai-storm-backend",
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  console.log(
    `${new Date().toISOString()} INFO  otel.started ` +
      JSON.stringify({ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318" }),
  );

  const shutdown = () => {
    sdk.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (err) {
  console.warn(
    `${new Date().toISOString()} WARN  otel.unavailable ` +
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
  );
}
