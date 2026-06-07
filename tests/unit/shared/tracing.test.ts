import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring of `startTracing()` / `shutdownTracing()`. Tracing exports spans over
 * OTLP and is gated by TRACING_ENABLED. We mock the OpenTelemetry trace SDK so
 * we can assert the plumbing (exporter endpoint/headers, sampler, provider
 * registration, flush on shutdown) without any real provider or network.
 * `vi.resetModules()` + dynamic import lets each case re-read config from a
 * freshly-set environment. Span *semantics* are covered in `tracingSpans.test.ts`.
 */

const otel = vi.hoisted(() => {
  const register = vi.fn();
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const NodeTracerProvider = vi.fn(() => ({ register, shutdown }));
  const BatchSpanProcessor = vi.fn((exporter: unknown) => ({ exporter }));
  const ParentBasedSampler = vi.fn((cfg: unknown) => ({ cfg }));
  const TraceIdRatioBasedSampler = vi.fn((ratio: unknown) => ({ ratio }));
  const OTLPTraceExporter = vi.fn((cfg: unknown) => ({ cfg }));
  return { register, shutdown, NodeTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, OTLPTraceExporter };
});

vi.mock('@opentelemetry/sdk-trace-node', () => ({ NodeTracerProvider: otel.NodeTracerProvider }));
vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: otel.BatchSpanProcessor,
  ParentBasedSampler: otel.ParentBasedSampler,
  TraceIdRatioBasedSampler: otel.TraceIdRatioBasedSampler,
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: otel.OTLPTraceExporter }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (a: unknown) => a }));

const TRACE_ENV = [
  'TRACING_ENABLED',
  'TRACING_SAMPLE_RATIO',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME',
] as const;
function clearTraceEnv(): void {
  for (const k of TRACE_ENV) delete process.env[k];
}

describe('tracing (disabled — default test env)', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(otel).forEach((fn) => fn.mockClear());
    clearTraceEnv();
  });

  it('startTracing is a no-op when disabled (no exporter/provider constructed)', async () => {
    const { startTracing } = await import('../../../src/shared/tracing');
    expect(() => startTracing()).not.toThrow();
    expect(otel.OTLPTraceExporter).not.toHaveBeenCalled();
    expect(otel.NodeTracerProvider).not.toHaveBeenCalled();
    expect(otel.register).not.toHaveBeenCalled();
  });

  it('withSpan still runs the function and returns its value', async () => {
    const { withSpan } = await import('../../../src/shared/tracing');
    await expect(withSpan('op', () => 'done')).resolves.toBe('done');
  });

  it('withSpan propagates a thrown error', async () => {
    const { withSpan } = await import('../../../src/shared/tracing');
    await expect(withSpan('op', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('shutdownTracing resolves cleanly when nothing was started', async () => {
    const { shutdownTracing } = await import('../../../src/shared/tracing');
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});

describe('tracing (enabled)', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(otel).forEach((fn) => fn.mockClear());
    clearTraceEnv();
    process.env.TRACING_ENABLED = 'true';
    process.env.OTEL_SERVICE_NAME = 'charmshot-test';
  });
  afterEach(clearTraceEnv);

  it('builds the OTLP exporter, a ratio sampler, and registers the provider', async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://collector.example.com/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer tok,x-tenant=acme';
    process.env.TRACING_SAMPLE_RATIO = '0.5';
    const { startTracing } = await import('../../../src/shared/tracing');
    startTracing();

    expect(otel.OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'https://collector.example.com/v1/traces',
      headers: { Authorization: 'Bearer tok', 'x-tenant': 'acme' },
    });
    expect(otel.TraceIdRatioBasedSampler).toHaveBeenCalledWith(0.5);
    expect(otel.ParentBasedSampler).toHaveBeenCalledTimes(1);
    expect(otel.NodeTracerProvider).toHaveBeenCalledTimes(1);
    expect(otel.register).toHaveBeenCalledTimes(1);
  });

  it('derives the traces endpoint from the generic OTLP endpoint', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.example.com//';
    const { startTracing } = await import('../../../src/shared/tracing');
    startTracing();
    expect(otel.OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://collector.example.com/v1/traces' }),
    );
  });

  it('omits the url (exporter default) and headers when none are configured', async () => {
    const { startTracing } = await import('../../../src/shared/tracing');
    startTracing();
    expect(otel.OTLPTraceExporter).toHaveBeenCalledWith({});
  });

  it('clamps an out-of-range sample ratio into [0,1]', async () => {
    process.env.TRACING_SAMPLE_RATIO = '5';
    const { startTracing } = await import('../../../src/shared/tracing');
    startTracing();
    expect(otel.TraceIdRatioBasedSampler).toHaveBeenCalledWith(1);
  });

  it('is idempotent — a second startTracing does not reconstruct the provider', async () => {
    const { startTracing } = await import('../../../src/shared/tracing');
    startTracing();
    startTracing();
    expect(otel.NodeTracerProvider).toHaveBeenCalledTimes(1);
  });

  it('flushes/shuts down the provider on shutdown', async () => {
    const { startTracing, shutdownTracing } = await import('../../../src/shared/tracing');
    startTracing();
    await shutdownTracing();
    expect(otel.shutdown).toHaveBeenCalledTimes(1);
  });
});
