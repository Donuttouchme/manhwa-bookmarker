/**
 * Integration tests for SuwayomiClient.
 *
 * Requires a running Suwayomi instance at SUWAYOMI_URL (default: http://localhost:4567).
 * Requires the Bbato extension installed (pkgName: eu.kanade.tachiyomi.extension.en.bbato).
 * Bbato is the Keiyoushi catalog name for the Bato.To Tachiyomi extension.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { SuwayomiClient } from './suwayomi-client.js';

const SUWAYOMI_URL = process.env.SUWAYOMI_URL ?? 'http://localhost:4567';
const client = new SuwayomiClient(SUWAYOMI_URL);

/**
 * The extension name we installed. Checked in listSources / findSourceByName tests.
 * Bbato is a single-language (English) extension.
 */
const INSTALLED_EXT_NAME = 'Bbato';
const INSTALLED_EXT_LANG = 'en';

describe('SuwayomiClient', () => {
  beforeAll(async () => {
    const res = await fetch(SUWAYOMI_URL).catch((e) => {
      throw new Error(`Cannot reach Suwayomi at ${SUWAYOMI_URL}: ${(e as Error).message}`);
    });
    if (!res.ok) throw new Error(`Suwayomi at ${SUWAYOMI_URL} returned ${res.status}`);
  });

  it('listSources returns at least one source (Bbato installed)', async () => {
    const sources = await client.listSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.name === INSTALLED_EXT_NAME)).toBe(true);
  });

  it('findSourceByName returns Bbato source', async () => {
    const source = await client.findSourceByName(INSTALLED_EXT_NAME);
    expect(source).not.toBeNull();
    expect(source?.name).toBe(INSTALLED_EXT_NAME);
    expect(source?.lang).toBe(INSTALLED_EXT_LANG);
  });

  it('findSourceByName returns null for an uninstalled name', async () => {
    const source = await client.findSourceByName('ThisExtensionIsNotInstalled12345');
    expect(source).toBeNull();
  });

  it('gql throws on a malformed query', async () => {
    await expect(client.gql('this is not graphql')).rejects.toThrow();
  });
});
