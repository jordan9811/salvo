/**
 * The addresses Salvo answers on.
 *
 * APP_URL is the main one: links, wallet passes, payment resources and the
 * admin sign-in are built on it. The others serve the same app and pass the
 * same own-page checks: salvoapp.xyz (through Cloudflare), and the Railway
 * address, where the first passkey accounts were made. A passkey only works
 * on the address it was made on, and an account's wallet comes from its
 * passkey, so those accounts keep signing in there.
 */
const SERVED_ORIGINS: readonly string[] = ['https://salvoapp.xyz', 'https://www.salvoapp.xyz', 'https://web-production-4eedc.up.railway.app']

/** APP_URL's origin (the same default src/lib/env.ts gives it), or null for a value that is not a URL. */
function appOrigin(): string | null {
  try {
    return new URL(process.env.APP_URL ?? 'http://localhost:3000').origin
  } catch {
    return null
  }
}

/** Is this a page origin of ours? A malformed APP_URL still leaves the served addresses. */
export function isOurOrigin(origin: string): boolean {
  return origin === appOrigin() || SERVED_ORIGINS.includes(origin)
}

/**
 * The origin this request arrived on when it is one of ours, else APP_URL's:
 * where a person who started on one address is sent back to, and what their
 * passkey was made for. Only known addresses are taken from the request's
 * host; behind a proxy any other host is not the public one. Null when the
 * host is not one of them and APP_URL is not a URL.
 */
export function requestOrigin(req: Request): string | null {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  const here = `https://${host}`
  if (host !== '' && SERVED_ORIGINS.includes(here)) return here
  return appOrigin()
}
