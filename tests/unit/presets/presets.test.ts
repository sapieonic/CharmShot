import { describe, expect, it } from 'vitest';
import { PRESETS, getPreset, listPresets } from '../../../src/presets/presets';

const EXPECTED_IDS = ['casual-smart', 'business-elite', 'outdoor-adventure', 'luxury-lifestyle'];

describe('preset catalogue', () => {
  it('defines exactly the four expected presets', () => {
    expect(PRESETS).toHaveLength(4);
    expect(PRESETS.map((p) => p.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('every preset has all required, non-empty fields', () => {
    for (const p of PRESETS) {
      expect(typeof p.id).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.category.length).toBeGreaterThan(0);
      expect(p.promptTemplate.length).toBeGreaterThan(0);
    }
  });

  it('listPresets returns the catalogue', () => {
    expect(listPresets()).toEqual(PRESETS);
  });
});

describe('getPreset', () => {
  it('returns the preset for a known id', () => {
    expect(getPreset('business-elite')?.name).toBe('Business Elite');
  });

  it('returns undefined for an unknown id', () => {
    expect(getPreset('does-not-exist')).toBeUndefined();
  });
});

describe('identity-preservation guardrails', () => {
  it('every prompt template embeds the identity-preservation phrasing', () => {
    for (const p of PRESETS) {
      const t = p.promptTemplate;
      expect(t).toMatch(/identity/i);
      expect(t).toMatch(/do not change|don't change/i);
      // Must explicitly protect age, ethnicity, structure, and gender.
      expect(t).toMatch(/age/i);
      expect(t).toMatch(/ethnicity/i);
      expect(t).toMatch(/structure/i);
      expect(t).toMatch(/gender/i);
    }
  });
});
