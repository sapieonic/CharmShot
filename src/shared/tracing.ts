/**
 * Distributed tracing with OpenTelemetry spans.
 *
 * Mirrors `telemetry.ts` (log shipping): one TracerProvider for the process,
 * exported over OTLP/HTTP, and a complete no-op until `startTracing()` wires up
 * a real provider at boot. Because the OpenTelemetry *API* always hands back a
 * tracer — a no-op one when no provider is registered — every helper here is
 * safe to call unconditionally. Call sites never branch on whether tracing is
 * enabled; with it off, `withSpan` simply runs the function and `withSpan`/
 * `currentSpanContext` add nothing to logs.
 *
 * This module deliberately does NOT import `logger.ts` (the logger imports
 * `currentSpanContext` from here to stamp trace/span ids onto every line, so
 * importing it back would be a cycle). Its own rare diagnostics go straight to
 * stdout/stderr, exactly like `telemetry.ts`.
 *
 * Spans are nested via `startActiveSpan`, so anything started inside a
 * `withSpan` callback — across `await` boundaries — becomes a child
 * automatically (AsyncLocalStorage context propagation, wired by `.register()`).
 */

import {
  context as otelContext,
  propagation,
  trace,
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { Attributes, Context, Link, Span, Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { config } from '../config/env';

export { SpanKind, SpanStatusCode };
export type { Span };

let provider: NodeTracerProvider | undefined;

/**
 * Initialise OTLP trace export if TRACING_ENABLED=true. Idempotent and safe to
 * call when disabled (no-op). Call once at boot, before anything traces.
 */
export function startTracing(): void {
  if (provider) return; // already started

  const { enabled, endpoint, headers, sampleRatio, serviceName } = config.tracing;
  if (!enabled) return;

  try {
    const exporter = new OTLPTraceExporter({
      ...(endpoint ? { url: endpoint } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': serviceName }),
      // ParentBased: honour an inbound sampling decision; otherwise sample by
      // ratio. With ratio 1 this is effectively "always on".
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // register() installs this as the global provider AND sets up the
    // AsyncLocalStorage context manager + W3C trace-context propagator, so
    // spans nest across async boundaries and traceparent headers flow in/out.
    provider.register();
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        time: new Date().toISOString(),
        message: 'OpenTelemetry tracing enabled',
        endpoint: endpoint ?? 'otlp-default',
        sampleRatio,
      }) + '\n',
    );
  } catch (err) {
    process.stderr.write(`Failed to start OpenTelemetry tracing: ${String(err)}\n`);
  }
}

/** The process tracer. Returns a no-op tracer until `startTracing()` runs. */
export function getTracer(): Tracer {
  return trace.getTracer(config.tracing.serviceName);
}

export interface SpanOptions {
  /** Initial span attributes (low-cardinality keys; never secrets/PII). */
  attributes?: Attributes;
  /** Span kind: SERVER for inbound, CLIENT for outbound, CONSUMER for queue work. */
  kind?: SpanKind;
  /**
   * Parent context to start the span within — e.g. one returned by
   * `extractContext(...)` for an inbound request. Defaults to the active context.
   */
  parent?: Context;
  /**
   * Force a brand-new trace, ignoring any active/parent span. Needed when work
   * is dispatched synchronously inside another span's async context but should
   * be its own trace (e.g. the in-process queue draining within a request) —
   * use `links` to keep the connection back to the originator.
   */
  root?: boolean;
  /** Span links (e.g. the request that enqueued this background job). */
  links?: Link[];
}

/**
 * Run `fn` inside a new active span. The span is ended automatically; if `fn`
 * throws, the exception is recorded and the span status set to ERROR before the
 * error propagates. Sub-spans started inside `fn` nest under it.
 *
 * No-op-safe: with tracing disabled this just invokes `fn` with a
 * non-recording span.
 */
export function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, opts: SpanOptions = {}): Promise<T> {
  const tracer = getTracer();
  const startOptions = {
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.attributes ? { attributes: opts.attributes } : {}),
    ...(opts.links ? { links: opts.links } : {}),
    ...(opts.root ? { root: true } : {}),
  };
  // `root` forces a new trace regardless of context, so only thread a parent
  // context when not rooting.
  const parent = opts.parent ?? otelContext.active();
  return tracer.startActiveSpan(name, startOptions, parent, async (span) => {
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (err) {
      recordSpanError(span, err);
      span.end();
      throw err;
    }
  });
}

/** Record an exception on a span and mark it failed. Safe on any span. */
export function recordSpanError(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : { name: 'Error', message: String(err) });
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
}

/** Set attributes on the current active span, if any. No-op otherwise. */
export function setActiveSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** Mark the current active span as failed, if any. No-op otherwise. */
export function markActiveSpanError(err: unknown): void {
  const span = trace.getActiveSpan();
  if (span) recordSpanError(span, err);
}

/**
 * Trace/span ids of the current active span, for log correlation. Returns
 * `undefined` when there's no recording span (e.g. tracing disabled), so
 * disabled-tracing log lines are byte-for-byte unchanged.
 */
export function currentSpanContext(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const sc = span.spanContext();
  if (!isSpanContextValid(sc)) return undefined;
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

/**
 * Inject the active trace context into a carrier (W3C `traceparent`/`tracestate`)
 * so it can ride along with an enqueued message and link the consumer back to
 * the producer. Empty object when tracing is disabled / no active span.
 */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier;
}

/** Extract a parent context from a carrier (e.g. inbound headers or a message). */
export function extractContext(carrier: Record<string, string | undefined>): Context {
  return propagation.extract(otelContext.active(), carrier);
}

/**
 * Build a span link to whatever context the carrier carries, or `undefined` if
 * it carries no valid span. Used to link a background job's span to the request
 * that enqueued it without forcing it into the request's trace.
 */
export function linkFromCarrier(carrier: Record<string, string | undefined>): Link | undefined {
  const ctx = extractContext(carrier);
  const sc = trace.getSpanContext(ctx);
  if (!sc || !isSpanContextValid(sc)) return undefined;
  return { context: sc };
}

/** Flush and shut down the trace pipeline. Safe to call when disabled (no-op). */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    try {
      await provider.shutdown();
    } catch (err) {
      process.stderr.write(`OpenTelemetry tracing shutdown error: ${String(err)}\n`);
    }
  }
  provider = undefined;
}
