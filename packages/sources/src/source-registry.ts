/**
 * Maps source-site hostnames to the Tachiyomi/Suwayomi extension that handles them.
 * The extension `name` is the human-readable name we use to look up the Suwayomi
 * source ID at runtime (via the `aboutSource` GraphQL query).
 *
 * Add a row here when adding a new site we support. The same extension can map
 * to multiple hosts when a site has been rebranded (e.g. AsuraScans → AsuraComic).
 */
export interface SourceRegistryEntry {
  /** Extension name as shown in Suwayomi's source list (e.g. "Bato.To"). */
  extensionName: string;
  /** Hosts the extension recognizes. Lowercased; no port. */
  hosts: readonly string[];
  /** Language code expected by Suwayomi for this source (e.g. "en"). */
  lang: string;
}

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    extensionName: 'Bato.To',
    hosts: ['bato.to', 'mto.to', 'wto.to', 'hto.to', 'dto.to', 'fto.to', 'jto.to', 'kto.to'],
    lang: 'en',
  },
  {
    extensionName: 'AsuraScans',
    hosts: ['asurascans.com', 'asuracomic.net', 'asura.gg', 'asuratoon.com'],
    lang: 'en',
  },
  {
    extensionName: 'ReaperScans',
    hosts: ['reaperscans.com'],
    lang: 'en',
  },
  {
    extensionName: 'MangaBuddy',
    hosts: ['mangabuddy.com'],
    lang: 'en',
  },
  {
    extensionName: 'Flame Comics',
    hosts: ['flamecomics.xyz', 'flamecomics.com'],
    lang: 'en',
  },
  {
    extensionName: 'Vortex Scans',
    hosts: ['vortexscans.com', 'vortexscans.org'],
    lang: 'en',
  },
];

/** Look up the registry entry for a hostname; null if unknown. */
export function findRegistryEntry(host: string): SourceRegistryEntry | null {
  const lower = host.toLowerCase();
  return SOURCE_REGISTRY.find((e) => e.hosts.includes(lower)) ?? null;
}
