import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Telemetry ships logs to PostHog Logs over OTLP. It's gated by
 * POSTHOG_LOGS_ENABLED + an API key. We mock the OpenTelemetry SDK modules so we
 * can assert the wiring (exporter URL/headers, severity mapping, attribute
 * serialization, flush on shutdown) without any real network/SDK side effects.
 * `vi.resetModules()` + dynamic import lets each case re-read config from a
 * freshly-set environment.
 */

const otel = vi.hoisted(() => {
  const emit = vi.fn();
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const getLogger = vi.fn(() => ({ emit }));
  const LoggerProvider = vi.fn(() => ({ getLogger, shutdown }));
  const BatchLogRecordProcessor = vi.fn((exporter: unknown) => ({ exporter }));
  const OTLPLogExporter = vi.fn((cfg: unknown) => ({ cfg }));
  const setGlobalLoggerProvider = vi.fn();
  return { emit, shutdown, getLogger, LoggerProvider, BatchLogRecordProcessor, OTLPLogExporter, setGlobalLoggerProvider };
});

vi.mock('@opentelemetry/api-logs', () => ({
  logs: { setGlobalLoggerProvider: otel.setGlobalLoggerProvider },
  SeverityNumber: { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 },
}));
vi.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: otel.LoggerProvider,
  BatchLogRecordProcessor: otel.BatchLogRecordProcessor,
}));
vi.mock('@opentelemetry/exporter-logs-otlp-http', () => ({ OTLPLogExporter: otel.OTLPLogExporter }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (a: unknown) => a }));

const LOG_ENV = ['POSTHOG_LOGS_ENABLED', 'POSTHOG_API_KEY', 'POSTHOG_HOST', 'POSTHOG_SERVICE_NAME'] as const;
function clearLogEnv(): void {
  for (const k of LOG_ENV) delete process.env[k];
}

describe('telemetry (disabled — default test env)', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(otel).forEach((fn) => fn.mockClear());
    clearLogEnv();
  });

  it('startTelemetry is a no-op when logs are disabled (no exporter constructed)', async () => {
    const { startTelemetry } = await import('../../../src/shared/telemetry');
    expect(() => startTelemetry()).not.toThrow();
    expect(otel.OTLPLogExporter).not.toHaveBeenCalled();
    expect(otel.setGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  it('startTelemetry is a no-op when enabled but no API key is set', async () => {
    process.env.POSTHOG_LOGS_ENABLED = 'true';
    const { startTelemetry } = await import('../../../src/shared/telemetry');
    startTelemetry();
    expect(otel.OTLPLogExporter).not.toHaveBeenCalled();
  });

  it('emitOtelLog does nothing before a pipeline is started', async () => {
    const { emitOtelLog } = await import('../../../src/shared/telemetry');
    expect(() => emitOtelLog('info', 'hello', { uid: 'u1' })).not.toThrow();
    expect(otel.emit).not.toHaveBeenCalled();
  });

  it('shutdownTelemetry resolves cleanly when nothing was started', async () => {
    const { shutdownTelemetry } = await import('../../../src/shared/telemetry');
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('telemetry (enabled)', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(otel).forEach((fn) => fn.mockClear());
    process.env.POSTHOG_LOGS_ENABLED = 'true';
    process.env.POSTHOG_API_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://us.i.posthog.com';
    process.env.POSTHOG_SERVICE_NAME = 'charmshot-test';
  });
  afterEach(clearLogEnv);

  it('builds the OTLP exporter with the logs endpoint and bearer auth', async () => {
    const { startTelemetry } = await import('../../../src/shared/telemetry');
    startTelemetry();
    expect(otel.OTLPLogExporter).toHaveBeenCalledWith({
      url: 'https://us.i.posthog.com/i/v1/logs',
      headers: { Authorization: 'Bearer phc_test' },
    });
    expect(otel.LoggerProvider).toHaveBeenCalledTimes(1);
    expect(otel.setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
    expect(otel.getLogger).toHaveBeenCalledWith('charmshot-test');
  });

  it('strips trailing slashes from the host when building the endpoint', async () => {
    process.env.POSTHOG_HOST = 'https://eu.i.posthog.com///';
    const { startTelemetry } = await import('../../../src/shared/telemetry');
    startTelemetry();
    expect(otel.OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://eu.i.posthog.com/i/v1/logs' }),
    );
  });

  it('is idempotent — a second startTelemetry does not reconstruct the pipeline', async () => {
    const { startTelemetry } = await import('../../../src/shared/telemetry');
    startTelemetry();
    startTelemetry();
    expect(otel.LoggerProvider).toHaveBeenCalledTimes(1);
  });

  it('emitOtelLog maps severity, sets the body, and serializes attributes', async () => {
    const { startTelemetry, emitOtelLog } = await import('../../../src/shared/telemetry');
    startTelemetry();
    emitOtelLog('error', 'boom', {
      uid: 'u1',
      count: 3,
      ok: true,
      obj: { a: 1 },
      err: new Error('kaboom'),
      skip: undefined,
      alsoSkip: null,
    });
    expect(otel.emit).toHaveBeenCalledTimes(1);
    const record = otel.emit.mock.calls[0]![0] as {
      severityNumber: number;
      severityText: string;
      body: string;
      attributes: Record<string, unknown>;
    };
    expect(record.severityNumber).toBe(17); // ERROR
    expect(record.severityText).toBe('error');
    expect(record.body).toBe('boom');
    expect(record.attributes).toMatchObject({ uid: 'u1', count: 3, ok: true, obj: '{"a":1}' });
    expect(record.attributes.err).toContain('"message":"kaboom"');
    expect(record.attributes).not.toHaveProperty('skip');
    expect(record.attributes).not.toHaveProperty('alsoSkip');
  });

  it('swallows a throwing emit so log shipping never breaks the caller', async () => {
    otel.emit.mockImplementationOnce(() => {
      throw new Error('exporter error');
    });
    const { startTelemetry, emitOtelLog } = await import('../../../src/shared/telemetry');
    startTelemetry();
    expect(() => emitOtelLog('info', 'hello', {})).not.toThrow();
  });

  it('flushes the pipeline on shutdown', async () => {
    const { startTelemetry, shutdownTelemetry } = await import('../../../src/shared/telemetry');
    startTelemetry();
    await shutdownTelemetry();
    expect(otel.shutdown).toHaveBeenCalledTimes(1);
  });
});
