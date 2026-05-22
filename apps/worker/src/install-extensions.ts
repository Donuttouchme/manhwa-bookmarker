import { SuwayomiClient } from '@manhwa/sources';

/**
 * Fields we need from Suwayomi's ExtensionType.
 *
 * Schema notes (v2.2.2100):
 *  - `isInstalled` (not `installed`) is the correct field name.
 *  - `pkgName` is the Java package name used as the extension ID (e.g.
 *    "eu.kanade.tachiyomi.extension.en.bbato").
 *  - `apkName` is the filename of the APK in the repository.
 *  - `name` is the human-readable display name (e.g. "Asura Scans" — note the
 *    space, whereas our SOURCE_REGISTRY uses "AsuraScans" with no space).
 *
 * Install mechanism (v2.2.2100):
 *  - `installExternalExtension` takes a file upload (not a pkgName string), so
 *    it cannot be used to install from the catalog.
 *  - The correct approach is `updateExtension(input: { id: <pkgName>, patch:
 *    { install: true } })` where `id` is the full Java package name.
 */
interface ExtensionInfo {
  apkName: string;
  pkgName: string;
  name: string;
  isInstalled: boolean;
}

/**
 * Fetch all extensions known to the Suwayomi repository (installed + available).
 */
async function fetchAvailableExtensions(client: SuwayomiClient): Promise<ExtensionInfo[]> {
  const data = await client.gql<{ fetchExtensions: { extensions: ExtensionInfo[] } }>(`
    mutation { fetchExtensions(input: {}) { extensions { apkName pkgName name isInstalled } } }
  `);
  return data.fetchExtensions.extensions;
}

/**
 * Install an extension by its Java package name (pkgName).
 *
 * Uses `updateExtension(input: { id: pkgName, patch: { install: true } })`.
 * This is the v2.x equivalent of "install from catalog".
 */
async function installExtension(client: SuwayomiClient, pkgName: string): Promise<void> {
  await client.gql(
    `mutation Install($id: String!) {
      updateExtension(input: { id: $id, patch: { install: true } }) {
        clientMutationId
      }
    }`,
    { id: pkgName },
  );
}

/**
 * Normalize an extension name for fuzzy matching.
 * Strips spaces, hyphens, underscores and lowercases the result so that
 * "AsuraScans" matches "Asura Scans" and "asurascans".
 */
function normalizeExtName(name: string): string {
  return name.replace(/[\s\-_]+/g, '').toLowerCase();
}

/**
 * Find an extension by matching either:
 *  a) exact `name` field (e.g. "Bbato", "Flame Comics")
 *  b) normalized name (e.g. "AsuraScans" ↔ "Asura Scans")
 *  c) the last component of `pkgName` (e.g. "asurascans" in
 *     "eu.kanade.tachiyomi.extension.en.asurascans")
 *
 * This covers the case where the Suwayomi display name has different spacing
 * from the name in SOURCE_REGISTRY (e.g. "AsuraScans" vs "Asura Scans").
 */
function findExtension(available: ExtensionInfo[], targetName: string): ExtensionInfo | null {
  const normalTarget = normalizeExtName(targetName);
  return (
    available.find((e) => {
      if (e.name === targetName) return true;
      if (normalizeExtName(e.name) === normalTarget) return true;
      const pkgSuffix = e.pkgName.split('.').at(-1) ?? '';
      if (pkgSuffix === normalTarget) return true;
      return false;
    }) ?? null
  );
}

async function main() {
  const suwayomiUrl = process.env.SUWAYOMI_URL ?? 'http://localhost:4567';
  const client = new SuwayomiClient(suwayomiUrl);

  // Target list: extension names from SOURCE_REGISTRY in packages/sources.
  // "ReaperScans" is included for completeness but may not exist in the
  // Keiyoushi catalog (it was not present as of 2026-05-22).
  const want = ['Bbato', 'AsuraScans', 'ReaperScans', 'MangaBuddy', 'Flame Comics'];

  console.log(`Fetching available extensions from ${suwayomiUrl}…`);
  const available = await fetchAvailableExtensions(client);
  console.log(`Found ${available.length} available extensions.`);

  for (const targetName of want) {
    const target = findExtension(available, targetName);
    if (!target) {
      console.warn(`  - ${targetName}: not found in available list (catalog may not include it)`);
      continue;
    }
    if (target.isInstalled) {
      console.log(`  - ${targetName}: already installed (${target.pkgName})`);
      continue;
    }
    console.log(`  - ${targetName}: installing (${target.pkgName})…`);
    try {
      await installExtension(client, target.pkgName);
      console.log(`  - ${targetName}: installed`);
    } catch (err) {
      console.error(`  - ${targetName}: install failed — ${(err as Error).message}`);
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
