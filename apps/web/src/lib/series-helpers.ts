import { compareTwoStrings } from 'string-similarity';

const SCANLATOR_PREFIX = /^[a-z0-9.\-\s]+\s*·\s*/i;
/** Strip punctuation that varies across source sites (colons, commas, etc.) */
const PUNCTUATION = /[^\w\s]/g;

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(SCANLATOR_PREFIX, '')
    .replace(PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score in [0, 1] of how similar two titles are after light normalization.
 * 1 = identical, 0 = unrelated.
 */
export function titleSimilarity(a: string, b: string): number {
  return compareTwoStrings(normalize(a), normalize(b));
}

/**
 * Threshold above which we suggest "attach to existing" instead of "create new".
 * Empirically: 0.82 keeps "Solo Leveling" vs "Solo Leveling Ragnarok" as different
 * but matches "Bato.To · Solo Leveling" to "Solo Leveling".
 */
export const TITLE_MATCH_THRESHOLD = 0.82;
