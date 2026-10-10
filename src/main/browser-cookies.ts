// Convert WebExtension cookies without flattening private/container/partitioned
// scopes into the shared browser session. Never include values in diagnostics.
export function importedCookie(input: unknown, now = Date.now() / 1000) {
  if (!input || typeof input !== 'object') return null;
  const cookie = input as Record<string, unknown>;
  if (cookie.partitionKey || cookie.firstPartyDomain || (cookie.storeId !== undefined && !['0', 'firefox-default'].includes(String(cookie.storeId)))) return null;
  if (typeof cookie.domain !== 'string' || !/^\.?[a-z\d.-]+$/i.test(cookie.domain) || cookie.domain.length > 254) return null;
  const host = cookie.domain.replace(/^\./, '');
  if (!host || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || cookie.name.length + cookie.value.length > 8192) return null;
  if (typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 4096) return null;
  if (typeof cookie.hostOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || typeof cookie.httpOnly !== 'boolean' || typeof cookie.session !== 'boolean') return null;
  const sameSite = cookie.sameSite ?? 'unspecified';
  if (!['unspecified','no_restriction','lax','strict'].includes(String(sameSite))) return null;
  if (!cookie.session && (typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= now)) return null;
  const url = new URL(`${cookie.secure ? 'https' : 'http'}://${host}/`);
  if (url.hostname !== host.toLowerCase()) return null;
  return {
    url: url.href, name: cookie.name, value: cookie.value, path: cookie.path,
    secure: cookie.secure, httpOnly: cookie.httpOnly,
    sameSite: sameSite as 'unspecified' | 'no_restriction' | 'lax' | 'strict',
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    ...(cookie.session ? {} : { expirationDate: cookie.expirationDate as number }),
  };
}
