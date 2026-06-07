import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { Logger } from '../../../src/shared/logger';
import {
  currentSpanContext,
  extractContext,
  injectTraceContext,
  linkFromCarrier,
  markActiveSpanError,
  recordSpanError,
  setActiveSpanAttributes,
  SpanKind,
  SpanStatusCode,
  withSpan,
} from '../../../src/shared/tracing';

/**
 * Span *semantics* against a real recording provider (in-memory exporter +
 * SimpleSpanProcessor, so finished spans are readable synchronously). This
 * exercises the public helpers — nesting, attributes, error status, log
 * correlation, and trace-context propagation — without any network export and
 * without depending on `startTracing()`/config flags. The wiring of
 * `startTracing()` itself is covered separately in `tracing.test.ts`.
 */

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  // register() installs the global provider + AsyncLocalStorage context manager
  // + W3C propagator, so startActiveSpan nesting and inject/extract work.
  provider.register();
});

afterEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe('withSpan', () => {
  it('records a span with name, kind, and attributes and returns the result', async () => {
    const result = await withSpan('test.op', () => 42, {
      kind: SpanKind.SERVER,
      attributes: { 'http.route': '/v1/things' },
    });
    expect(result).toBe(42);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('test.op');
    expect(spans[0]!.kind).toBe(SpanKind.SERVER);
    expect(spans[0]!.attributes['http.route']).toBe('/v1/things');
    expect(spans[0]!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('nests spans started inside the callback under the active span', async () => {
    await withSpan('parent', async () => {
      await withSpan('child', () => undefined);
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'parent')!;
    const child = spans.find((s) => s.name === 'child')!;
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    // Same trace, and the child's parent is the parent span.
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('records the exception, sets ERROR status, and rethrows on failure', async () => {
    const boom = new Error('kaboom');
    await expect(withSpan('failing', () => Promise.reject(boom))).rejects.toThrow('kaboom');

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('kaboom');
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('starts within an explicit parent context when one is provided', async () => {
    // Build a carrier from one trace, then start a span parented to it.
    let carrier: Record<string, string> = {};
    await withSpan('producer', () => {
      carrier = injectTraceContext();
    });
    const producerTraceId = exporter.getFinishedSpans()[0]!.spanContext().traceId;
    exporter.reset();

    await withSpan('consumer', () => undefined, { parent: extractContext(carrier) });
    expect(exporter.getFinishedSpans()[0]!.spanContext().traceId).toBe(producerTraceId);
  });
});

describe('active-span helpers', () => {
  it('setActiveSpanAttributes writes onto the current span', async () => {
    await withSpan('op', () => {
      setActiveSpanAttributes({ 'job.outcome': 'succeeded' });
    });
    expect(exporter.getFinishedSpans()[0]!.attributes['job.outcome']).toBe('succeeded');
  });

  it('markActiveSpanError marks the current span failed', async () => {
    await withSpan('op', () => {
      markActiveSpanError(new Error('nope'));
    });
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('recordSpanError tolerates non-Error throwables', async () => {
    await withSpan('op', (span) => {
      recordSpanError(span, 'string failure');
    });
    expect(exporter.getFinishedSpans()[0]!.status.message).toBe('string failure');
  });

  it('helpers are no-ops outside any span (do not throw)', () => {
    expect(() => setActiveSpanAttributes({ a: 1 })).not.toThrow();
    expect(() => markActiveSpanError(new Error('x'))).not.toThrow();
  });
});

describe('currentSpanContext', () => {
  it('returns the active span ids inside a span', async () => {
    await withSpan('op', () => {
      const ctx = currentSpanContext();
      expect(ctx).toBeDefined();
      expect(ctx!.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(ctx!.span_id).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  it('returns undefined when no span is active', () => {
    expect(currentSpanContext()).toBeUndefined();
  });
});

describe('trace-context propagation', () => {
  it('inject then extract round-trips the span context', async () => {
    let carrier: Record<string, string> = {};
    let innerIds: { trace_id: string; span_id: string } | undefined;
    await withSpan('producer', () => {
      innerIds = currentSpanContext();
      carrier = injectTraceContext();
    });

    expect(carrier.traceparent).toContain(innerIds!.trace_id);

    const link = linkFromCarrier(carrier);
    expect(link).toBeDefined();
    expect(link!.context.traceId).toBe(innerIds!.trace_id);
    expect(link!.context.spanId).toBe(innerIds!.span_id);
  });

  it('linkFromCarrier returns undefined for a carrier with no trace context', () => {
    expect(linkFromCarrier({})).toBeUndefined();
  });

  it('injectTraceContext is empty outside any span', () => {
    expect(injectTraceContext()).toEqual({});
  });
});

describe('log ↔ trace correlation', () => {
  it('stamps trace_id/span_id onto log lines emitted inside a span', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await withSpan('op', () => {
        const ids = currentSpanContext()!;
        // LOG_LEVEL=error in the test env, so use error (→ stderr).
        new Logger({ requestId: 'r1' }).error('boom');
        const line = JSON.parse((write.mock.calls.at(-1)![0] as string).trim());
        expect(line.trace_id).toBe(ids.trace_id);
        expect(line.span_id).toBe(ids.span_id);
        expect(line.requestId).toBe('r1');
      });
    } finally {
      write.mockRestore();
    }
  });

  it('adds no trace fields to log lines emitted outside any span', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      new Logger().error('boom');
      const line = JSON.parse((write.mock.calls.at(-1)![0] as string).trim());
      expect(line).not.toHaveProperty('trace_id');
      expect(line).not.toHaveProperty('span_id');
    } finally {
      write.mockRestore();
    }
  });
});
