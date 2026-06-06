/**
 * Model provider registry / factory.
 *
 * Providers register themselves (or are registered at bootstrap) by id. The
 * generation pipeline resolves providers exclusively through getModelProvider,
 * keeping it fully provider-agnostic.
 */

import { Errors } from '../shared/errors';
import type { ImageProvider } from './types';

const registry = new Map<string, ImageProvider>();

export function registerModelProvider(modelId: string, provider: ImageProvider): void {
  registry.set(modelId, provider);
}

export function getModelProvider(modelId: string): ImageProvider {
  const provider = registry.get(modelId);
  if (!provider) {
    throw Errors.invalidInput(`Unknown modelId: ${modelId}`, {
      available: listModelIds(),
    });
  }
  return provider;
}

export function hasModelProvider(modelId: string): boolean {
  return registry.has(modelId);
}

export function listModelIds(): string[] {
  return [...registry.keys()];
}

/** Test helper: wipe the registry. */
export function _resetRegistry(): void {
  registry.clear();
}
