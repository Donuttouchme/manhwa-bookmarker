import { describe, expect, it } from 'vitest';
import { findRegistryEntry, SOURCE_REGISTRY } from './source-registry.js';

describe('source registry', () => {
  it('finds the Bato.To extension (Bbato) for bato.to', () => {
    const entry = findRegistryEntry('bato.to');
    expect(entry?.extensionName).toBe('Bbato');
  });

  it('finds Asura Scans for any of the rebrand hostnames', () => {
    for (const host of ['asurascans.com', 'asuracomic.net', 'asura.gg', 'asuratoon.com']) {
      expect(findRegistryEntry(host)?.extensionName, `host=${host}`).toBe('Asura Scans');
    }
  });

  it('is case-insensitive', () => {
    expect(findRegistryEntry('BATO.TO')?.extensionName).toBe('Bbato');
  });

  it('returns null for unknown hosts', () => {
    expect(findRegistryEntry('example.com')).toBeNull();
  });

  it('has no duplicate hosts across entries', () => {
    const seen = new Map<string, string>();
    for (const entry of SOURCE_REGISTRY) {
      for (const host of entry.hosts) {
        const lower = host.toLowerCase();
        const existing = seen.get(lower);
        if (existing) {
          throw new Error(`duplicate host ${lower} in ${existing} and ${entry.extensionName}`);
        }
        seen.set(lower, entry.extensionName);
      }
    }
  });
});
