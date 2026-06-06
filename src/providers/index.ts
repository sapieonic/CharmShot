/**
 * Provider bootstrap. Importing this module registers all built-in providers.
 * Add new providers here (one line each) — no orchestration changes needed.
 */

import { registerModelProvider } from './factory';
import { NanoBananaProvider } from './nanoBananaProvider';
import { OpenAIProvider } from './openAiProvider';

let bootstrapped = false;

export function bootstrapProviders(): void {
  if (bootstrapped) return;
  registerModelProvider('nano-banana', new NanoBananaProvider());
  registerModelProvider('openai', new OpenAIProvider());
  // registerModelProvider('future-model', new FutureModelProvider());
  bootstrapped = true;
}

export * from './factory';
export * from './strategy';
export * from './types';
