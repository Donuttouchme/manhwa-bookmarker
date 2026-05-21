import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from './url-canonicalize.js';

describe('canonicalizeUrl', () => {
  it('lowercases the host', () => {
    const result = canonicalizeUrl('https://BATO.TO/title/123-foo');
    expect(result.host).toBe('bato.to');
    expect(result.href).toBe('https://bato.to/title/123-foo');
  });

  it('strips query strings', () => {
    const result = canonicalizeUrl('https://bato.to/title/123?utm_source=share');
    expect(result.href).toBe('https://bato.to/title/123');
  });

  it('strips a trailing slash', () => {
    const result = canonicalizeUrl('https://bato.to/title/123/');
    expect(result.path).toBe('/title/123');
    expect(result.href).toBe('https://bato.to/title/123');
  });

  it('preserves a multi-segment path', () => {
    const result = canonicalizeUrl('https://asuracomic.net/series/solo-leveling-aabb');
    expect(result.path).toBe('/series/solo-leveling-aabb');
  });

  it('drops the default https port', () => {
    const result = canonicalizeUrl('https://bato.to:443/title/123');
    expect(result.host).toBe('bato.to');
    expect(result.href).toBe('https://bato.to/title/123');
  });

  it('throws on non-http(s) URLs', () => {
    expect(() => canonicalizeUrl('file:///etc/passwd')).toThrow();
    expect(() => canonicalizeUrl('javascript:alert(1)')).toThrow();
  });

  it('throws on completely invalid URLs', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow();
  });
});
