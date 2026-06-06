/**
 * Structured JSON logger.
 *
 * Emits one JSON object per line to stdout/stderr so CloudWatch Logs Insights
 * can query by requestId, uid, jobId, etc. A logger carries a bound context
 * object that is merged into every line.
 */

import { config } from '../config/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  requestId?: string;
  uid?: string;
  jobId?: string;
  [key: string]: unknown;
}

function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const maybeCode = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(typeof maybeCode === 'string' ? { code: maybeCode } : {}),
    };
  }
  return { value: String(err) };
}

export class Logger {
  private readonly context: LogContext;
  private readonly threshold: number;

  constructor(context: LogContext = {}) {
    this.context = context;
    const level = (config.logLevel as LogLevel) in LEVEL_WEIGHT ? (config.logLevel as LogLevel) : 'info';
    this.threshold = LEVEL_WEIGHT[level];
  }

  /** Returns a new logger with additional bound context. */
  child(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const line = {
      level,
      time: new Date().toISOString(),
      message,
      ...this.context,
      ...(extra ?? {}),
    };
    const out = JSON.stringify(line);
    if (level === 'error' || level === 'warn') {
      process.stderr.write(out + '\n');
    } else {
      process.stdout.write(out + '\n');
    }
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.write('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.write('warn', message, extra);
  }

  error(message: string, err?: unknown, extra?: Record<string, unknown>): void {
    this.write('error', message, { ...(extra ?? {}), ...(err !== undefined ? { error: serialiseError(err) } : {}) });
  }
}

export const rootLogger = new Logger();
