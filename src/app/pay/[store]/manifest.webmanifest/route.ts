/**
 * GET /pay/[store]/manifest.webmanifest: the store's Home Screen icon
 * (unified-account spec 10.2). "Salvo · Target", opening /pay/target.
 *
 * The till page links it (page.tsx generateMetadata). A store that is not
 * ours is a 404, as the till page is. Public and the same for everyone, so
 * it may be cached; it names no shopper.
 */

import { storeManifest, tillStoreOf } from '../../stores'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ store: string }> }): Promise<Response> {
  const store = tillStoreOf((await params).store)
  if (store === null) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
  return new Response(JSON.stringify(storeManifest(store)), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' },
  })
}
