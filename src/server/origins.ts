export function configuredOrigins(primary: unknown, additional: unknown = []): URL[] {
  if (!Array.isArray(additional)) throw new Error('allowedOrigins must be an array of HTTP/HTTPS origins');
  const hosts = new Map<string, URL>();
  for (const value of [primary, ...additional]) {
    if (typeof value !== 'string' || !value || /[\\\s*?#]/.test(value)) throw new Error('Invalid origin: use an explicit HTTP/HTTPS site address');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Origin must be an HTTP/HTTPS site address without credentials, path, query or fragment');
    const previous = hosts.get(url.host);
    if (previous && previous.origin !== url.origin) throw new Error('The same Host cannot use different origin schemes');
    hosts.set(url.host, url);
  }
  return [...hosts.values()];
}

export function optionalDomain(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return configuredOrigins(text.includes('://') ? text : `https://${text}`)[0].origin;
}
