/**
 * The escrow template's pins, as plain values the browser can load: where
 * ESCROW_V1 (templates.ts) takes them from, and what the seller's page and
 * the shopper's phone check our server against.
 *
 * WHY THEY LIVE IN THEIR OWN FILE. templates.ts hashes the template's source
 * with node:crypto, so no page can import it. If the pages took these values
 * from GET /api/escrow/config instead, a server that changed only that one
 * answer could name its own sealing key, and every card a seller typed would
 * be sealed to it, or name its own escrow, and a shopper's allowance would be
 * signed over to it. Built into the page, they change only with the page's
 * own code, which is the trust the spec already states (section 19, item 1).
 *
 * EDITED BY HAND AT THE PIN STEPS ONLY (spec section 15): the escrow address
 * and its deployer at step 3, the identity and sealing key at step 7, the
 * creation transaction at step 8. Each is lower-case hex, written exactly as
 * the step prints it. `escrowCodehash` equals the compiled artifact's
 * RUNTIME_KECCAK and the template's ESCROW_CODEHASH; tests hold all three
 * equal.
 *
 * Isomorphic: no imports but a type. Never a secret: all of it is public.
 */

import type { EscrowTemplate } from './templates'

export type EscrowPins = Pick<EscrowTemplate, 'encPub' | 'identity' | 'escrowCodehash' | 'escrowAddress' | 'escrowDeployer' | 'escrowCreationTx'>

export const ESCROW_V1_PINS: Readonly<EscrowPins> = Object.freeze({
  encPub: '0x034580968471306568d23fc9e56127394b53a414e8b272f82d1f72a6e2adccda24',
  identity: '0x9109cd47811a9fc64c88316d64954b6b228d2cfe',
  escrowCodehash: '0x6a13510f164201a1540ecb7deaa4a4cbf02135b67b89e69d074dc065a77a2824',
  escrowAddress: '0x75c9aabe8254559f865e14d6e5fa70c738869bef',
  escrowDeployer: '0xe11390d43bce5245789736096df41184d5b07f46',
  escrowCreationTx: '0xfe06c77078991aa4ca6493cf1d21c43f356ef53022b8498b78da7ebcd34dcdf4',
})

/**
 * ESCROW_V2's pins (templates.ts), from the same pin steps run with
 * --version 2 on 2026-10-12/13: SalvoEscrowV2 on the Tempo Moderato testnet,
 * its deployer and creation transaction, and the identity and sealing key of
 * the live bind on Lit. `escrowCodehash` equals the V2 artifact's
 * RUNTIME_KECCAK_V2 and the template's ESCROW_CODEHASH; tests hold all three
 * equal.
 */
export const ESCROW_V2_PINS: Readonly<EscrowPins> = Object.freeze({
  encPub: '0x02e4b2970532998a2ddcedb15c952f95b22f60ef90c6875fe784fe6205e9e10992',
  identity: '0x264a8ec05b8ac46d935495daee8670317c9420ba',
  escrowCodehash: '0xbd3777d4335de32a997387ee26a04bffad23ab9e11721093fb673d438c988413',
  escrowAddress: '0xa30d1631bf644fa608dacc02b6d2aebbc1cd200b',
  escrowDeployer: '0xc65f0c60c34e645aa54e2114c59b8df7d7cf7c47',
  escrowCreationTx: '0xc38e6e06863b4f5e6a3dfc8390966d61d5b6e8cfdf92dbb2dd95f2301731c640',
})
