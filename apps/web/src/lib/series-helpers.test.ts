import { describe, expect, it } from 'vitest';
import { titleSimilarity, TITLE_MATCH_THRESHOLD } from './series-helpers';

describe('titleSimilarity', () => {
  it('returns 1 for identical titles', () => {
    expect(titleSimilarity('Solo Leveling', 'Solo Leveling')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(titleSimilarity('Solo Leveling', 'solo leveling')).toBe(1);
  });

  it('ignores leading/trailing whitespace', () => {
    expect(titleSimilarity('  Solo Leveling  ', 'Solo Leveling')).toBe(1);
  });

  it('strips common scanlator prefixes like "Bato.To · "', () => {
    expect(titleSimilarity('Bato.To · Solo Leveling', 'Solo Leveling')).toBeGreaterThanOrEqual(
      TITLE_MATCH_THRESHOLD,
    );
  });

  it('returns a high score for near-matches', () => {
    expect(titleSimilarity('Solo Leveling', 'Solo: Leveling')).toBeGreaterThan(0.9);
  });

  it('keeps distinct sequels below the threshold', () => {
    expect(titleSimilarity('Solo Leveling', 'Solo Leveling Ragnarok')).toBeLessThan(
      TITLE_MATCH_THRESHOLD,
    );
  });

  it('returns a low score for unrelated titles', () => {
    expect(titleSimilarity('Solo Leveling', 'Berserk')).toBeLessThan(0.3);
  });
});
