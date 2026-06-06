import { describe, expect, it } from 'vitest';
import { getPresetViews } from '../../../src/services/presetService';
import { PRESETS } from '../../../src/presets/presets';

describe('getPresetViews', () => {
  it('returns one view per preset with the expected fields', () => {
    const views = getPresetViews();
    expect(views).toHaveLength(PRESETS.length);
    for (const v of views) {
      expect(Object.keys(v).sort()).toEqual(['category', 'description', 'id', 'name', 'promptTemplate']);
    }
  });

  it('maps each preset id/name/promptTemplate through faithfully', () => {
    const views = getPresetViews();
    const byId = new Map(views.map((v) => [v.id, v]));
    for (const p of PRESETS) {
      const v = byId.get(p.id)!;
      expect(v.name).toBe(p.name);
      expect(v.description).toBe(p.description);
      expect(v.category).toBe(p.category);
      expect(v.promptTemplate).toBe(p.promptTemplate);
    }
  });
});
