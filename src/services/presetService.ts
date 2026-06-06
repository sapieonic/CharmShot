/**
 * Preset service: expose the catalogue of style presets to clients. The full
 * prompt template is internal; clients receive id/name/description/category and
 * the (safe) prompt template for transparency.
 */

import { listPresets, type StylePreset } from '../presets/presets';

export interface PresetView {
  id: string;
  name: string;
  description: string;
  category: string;
  promptTemplate: string;
}

export function getPresetViews(): PresetView[] {
  return listPresets().map((p: StylePreset) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    promptTemplate: p.promptTemplate,
  }));
}
