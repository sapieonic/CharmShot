/**
 * OpenTelemetry log shipping to PostHog Logs.
 *
 * PostHog Logs is OTLP-native — no PostHog-specific SDK, just standard
 * OpenTelemetry libraries pointed at `${host}/i/v1/logs` with the project API
 * key as a bearer token. We keep a single LoggerProvider for the process.
 *
 * This module is intentionally decoupled from `logger.ts`: `logger.ts` calls
 * `emitOtelLog(...)` for every line, and that is a no-op until `startTelemetry()`
 * wires up a real OTel logger at boot. That keeps unit tests (which never start
 * telemetry) free of any OTLP/network side effects, and avoids an import cycle.
 *
 * To avoid that cycle this module does NOT import `logger.ts`; its own rare
 * diagnostics go straight to stderr.
 */

import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Logger as OtelLogger } from '@opentelemetry/api-logs';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { config } from '../config/env';

let provider: LoggerProvider | undefined;
let otelLogger: OtelLogger | undefined;

const SEVERITY_BY_LEVEL: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/**
 * Initialise OTLP log shipping if POSTHOG_LOGS_ENABLED=true and an API key is
 * set. Idempotent and safe to call when disabled (no-op). Call once at boot.
 */
export function startTelemetry(): void {
  if (otelLogger) return; // already started

  const { logsEnabled, apiKey, host, serviceName } = config.posthog;
  if (!logsEnabled || !apiKey) return;

  try {
    const exporter = new OTLPLogExporter({
      url: `${host.replace(/\/+$/, '')}/i/v1/logs`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    provider = new LoggerProvider({
      resource: resourceFromAttributes({ 'service.name': serviceName }),
      processors: [new BatchLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);
    otelLogger = provider.getLogger(serviceName);
    process.stdout.write(
      JSON.stringify({ level: 'info', time: new Date().toISOString(), message: 'PostHog log shipping enabled', host }) + '\n',
    );
  } catch (err) {
    process.stderr.write(`Failed to start PostHog log shipping: ${String(err)}\n`);
  }
}

/**
 * Forward a single log line to the OTel pipeline. No-op until telemetry is
 * started. `attributes` carries the structured context (requestId, uid, jobId…).
 */
export function emitOtelLog(level: string, message: string, attributes: Record<string, unknown>): void {
  if (!otelLogger) return;
  try {
    otelLogger.emit({
      severityNumber: SEVERITY_BY_LEVEL[level] ?? SeverityNumber.INFO,
      severityText: level,
      body: message,
      attributes: toLogAttributes(attributes),
    });
  } catch {
    // Never let log shipping break the request path.
  }
}

/** Flush and shut down the log pipeline. Safe to call when disabled (no-op). */
export async function shutdownTelemetry(): Promise<void> {
  if (provider) {
    try {
      await provider.shutdown();
    } catch (err) {
      process.stderr.write(`PostHog log shipping shutdown error: ${String(err)}\n`);
    }
  }
  provider = undefined;
  otelLogger = undefined;
}

/**
 * OTel log attributes must be primitives (or arrays of them). Objects are
 * JSON-stringified so structured context (e.g. a serialised error) survives.
 */
function toLogAttributes(ctx: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value instanceof Error) {
      // Error fields are non-enumerable, so JSON.stringify(err) === '{}'. Pull
      // them out explicitly so shipped logs keep the message/stack.
      out[key] = JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}
