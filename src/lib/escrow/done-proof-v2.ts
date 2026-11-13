/**
 * "Done with this card": what a shopper's phone gives our server once the
 * till is done with a card it bought on SalvoEscrowV2, so the leftover on that
 * card need not rest two hours before the next shopper is offered it
 * (till-quote-v2.ts restingV2, POST /api/escrow/done).
 *
 * THE BUYER IS WHOEVER HOLDS THE CARD'S REPLY KEY. Each card of a purchase
 * gets a fresh reply key on the phone (client/reply.ts), and the shopper's own
 * depositAndOpen put keccak256 of its public half on chain as the deposit's
 * replyKeyHash: the release route already lets only that key open the card.
 * So the same key signs one fixed text, naming the chain, the escrow, the
 * deposit and "done":
 *   salvo/escrow/done/v1|<chain id>|<escrow, lower case>|<deposit id>|done
 * ECDSA on secp256k1 over its SHA-256, 64 bytes r then s, low s only. A proof
 * for one deposit says nothing about any other, on any escrow or chain.
 *
 * SIGNED WHILE THE KEY IS STILL ON THE PHONE. A reply key is deleted once its
 * card is opened (load-v2.ts releaseLeg), seconds after the tap and before the
 * shopper is at the register, so the phone signs then, keeps the signature
 * with its purchase (records-v2.ts), and sends it only when the till is done
 * with the card. The signature opens nothing: all it can do is end its own
 * card's rest early, which is what its shopper asks for.
 *
 * Isomorphic: no Node imports. Never logs.
 */

import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { utf8ToBytes } from '@noble/hashes/utils'
import type { Hex } from 'viem'
import { pointBytes } from './client/primitives'

/** 64 bytes, r then s, lower-case hex: the only form a proof is taken in. */
const DONE_SIG_RE = /^0x[0-9a-f]{128}$/

/** Which card a proof is about: the deposit its purchase opened, on this escrow and chain. */
export interface DoneAt {
  chainId: number
  escrow: Hex
  /** In decimal, as the release route takes it. */
  depositId: string
}

/** The SHA-256 of the fixed text a proof signs. */
function doneDigestV2(at: DoneAt): Uint8Array {
  return sha256(utf8ToBytes(`salvo/escrow/done/v1|${at.chainId}|${at.escrow.toLowerCase()}|${at.depositId}|done`))
}

/** The proof, signed with the card's reply key `secretKey`. The caller zeroes the key. */
export function signDoneV2(secretKey: Uint8Array, at: DoneAt): Hex {
  return `0x${secp256k1.sign(doneDigestV2(at), secretKey).toCompactHex()}`
}

/**
 * Did the key whose public half is `replyKey` sign `signature` for exactly
 * this deposit? False for anything else: another deposit, escrow or chain, a
 * key not on the curve, a high s, or a signature in any other form.
 */
export function doneSignedV2(replyKey: string, signature: string, at: DoneAt): boolean {
  if (!DONE_SIG_RE.test(signature)) return false
  try {
    const sig = secp256k1.Signature.fromCompact(signature.slice(2))
    return secp256k1.verify(sig, doneDigestV2(at), pointBytes(replyKey), { lowS: true })
  } catch {
    return false
  }
}
