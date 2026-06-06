/**
 * Provider bootstrap. Importing this module registers all built-in providers.
 * Add new providers here (one line each) — no orchestration changes needed.
 */

import { registerModelProvider } from './factory';
import { NanoBananaProvider } from './nanoBananaProvider';

let bootstrapped = false;

export function bootstrapProviders(): void {
  if (bootstrapped) return;
  registerModelProvider('nano-banana', new NanoBananaProvider());
  // registerModelProvider('future-model', new FutureModelProvider());
  bootstrapped = true;
}

export * from './factory';
export * from './strategy';
export * from './types';
