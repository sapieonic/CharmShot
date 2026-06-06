import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The logger writes a JSON line to stdout/stderr AND forwards every emitted line
 * to PostHog Logs via telemetry.emitOtelLog. The test env sets LOG_LEVEL=error
 * (see tests/setup.ts), so only error-level lines pass the threshold. We mock
 * telemetry to assert the forwarding contract (level, message, merged context).
 */

const { emitOtelLogMock } = vi.hoisted(() => ({ emitOtelLogMock: vi.fn() }));
vi.mock('../../../src/shared/telemetry', () => ({ emitOtelLog: emitOtelLogMock }));

import { Logger } from '../../../src/shared/logger';

describe('Logger → OTel forwarding', () => {
  beforeEach(() => emitOtelLogMock.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it('forwards an error line with merged bound context, extra, and serialized error', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = new Logger({ requestId: 'r1' }).child({ uid: 'u1' });
    log.error('Generation failed', new Error('boom'), { jobId: 'j1' });

    expect(emitOtelLogMock).toHaveBeenCalledTimes(1);
    const [level, message, attributes] = emitOtelLogMock.mock.calls[0]!;
    expect(level).toBe('error');
    expect(message).toBe('Generation failed');
    expect(attributes).toMatchObject({ requestId: 'r1', uid: 'u1', jobId: 'j1' });
    expect(attributes.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('does not forward lines below the configured level threshold', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = new Logger();
    log.info('this is suppressed at LOG_LEVEL=error');
    log.debug('also suppressed');
    expect(emitOtelLogMock).not.toHaveBeenCalled();
  });

  it('still writes the structured line to stderr for error level', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    new Logger({ requestId: 'r1' }).error('oops');
    expect(write).toHaveBeenCalledTimes(1);
    const line = JSON.parse((write.mock.calls[0]![0] as string).trim());
    expect(line).toMatchObject({ level: 'error', message: 'oops', requestId: 'r1' });
  });
});
