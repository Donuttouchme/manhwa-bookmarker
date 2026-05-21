export interface CanonicalizedUrl {
  /** Lowercased host without port. */
  host: string;
  /** Path + slug (no query string, no trailing slash). */
  path: string;
  /** Reconstructed canonical URL: `https://${host}${path}`. */
  href: string;
}

/**
 * Normalize a source URL so that two URLs that mean the "same manga" produce
 * the same canonical form. Lowercases the host, drops query strings, drops a
 * trailing slash, drops any `:port` if it's the default.
 */
export function canonicalizeUrl(input: string): CanonicalizedUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Only http(s) URLs are supported, got: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return {
    host,
    path,
    href: `${parsed.protocol}//${host}${path}`,
  };
}
