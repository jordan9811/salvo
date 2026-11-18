/**
 * The escrow vault's names, as the custody guard sees them.
 *
 * A card sealed for the escrow rail is sealed in the seller's browser to the
 * frozen template salvo-vault-escrow/1. Its ref records the algorithm below;
 * the guard turns a ref into the backend tag (`backendOfSealedRef`) only when
 * the ref names that template with the pinned sha256 and CID and the template
 * here is intact.
 *
 * The tag carries the template's ACTUAL sha256, recomputed from the source at
 * load, like the attested tag in chipotle.ts. So an edited template computes a
 * different tag, and the guard classifies a tag it was never told about as
 * `unknown`.
 *
 * WHAT THIS DOES NOT DO: make the escrow non-custodial in the guard's eyes.
 * Today the tag is `unknown`, so every seller is refused. It joins
 * NON_CUSTODIAL_BACKENDS (guard.ts) only after the review in spec section 11:
 * live bind and pins, deployed code hash, the live smoke, a second reviewer,
 * testnet only. Until then nothing in this file changes what a seller can do.
 */

import { ESCROW_V1, templateIntegrity } from './lit/templates'

export const CHIPOTLE_ESCROW_ALGORITHM = 'chipotle:escrow:v1'
export const CHIPOTLE_ESCROW_BACKEND = `chipotle:escrow:v1@sha256:${templateIntegrity(ESCROW_V1).sha256}`
