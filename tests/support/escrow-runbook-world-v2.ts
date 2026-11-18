/**
 * The V2 runbook, offline: salvo-vault-escrow/2 pinned the way the lead will
 * pin it, a deployer that holds a real key, and the fake Moderato node.
 * Test-only; never referenced from src/.
 *
 * As escrow-runbook-world.ts does for V1. The committed V2 template is
 * pinned to the live Moderato deploy (2026-10-13), whose deployer key only
 * the lead holds, so these tests make the pin step themselves from the
 * unpinned bytes (the ESCROW line back to the placeholder; then a key, its
 * nonce-0 CREATE address in that line, the sha256 and CID of those bytes,
 * fake Lit's identity and encPub for that CID), and then the scripts' own
 * code deploys SalvoEscrowV2 there, checks it, and runs the V2 smoke against
 * it. For the live deployer the same helper gives the committed bytes back.
 */

import { createHash } from 'node:crypto'
import type { Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { ESCROW_PIN_PLACEHOLDER, escrowCreateAddress } from '@/lib/escrow/deployment'
import { deployEscrowLive, type DeployReport } from '@/lib/escrow/runbook/deploy'
import type { HostsConfig } from '@/lib/escrow/runbook/rpc'
import { litActionCid } from '@/lib/vault/lit/cid'
import { ESCROW_V2, type EscrowTemplate } from '@/lib/vault/lit/templates'
import { unpinnedSourceV2 } from './escrow-v2-unpinned'
import { fakeEncPubFor, fakeIdentityFor } from './fake-lit'
import { FakeTempoNode } from './fake-tempo-node'

type TemplateV2 = EscrowTemplate<'salvo-vault-escrow/2'>

/** The committed V2 template with its ESCROW line set back to the placeholder: the unpinned bytes, in either state. */
export const UNPINNED_SOURCE_V2 = unpinnedSourceV2(ESCROW_V2.source)

/** The V2 test deployer: a fixed key of its own, so its nonce-0 address is fixed and never V1's test deployer's. */
export const RUNBOOK_DEPLOYER_V2: PrivateKeyAccount = privateKeyToAccount(`0x${'d2'.repeat(32)}`)

const lower = (a: string): Hex => a.toLowerCase() as Hex

/**
 * salvo-vault-escrow/2 as the lead's pin and bind steps leave it, for
 * `deployer`: the ESCROW line set, the record filled in, and fake Lit's
 * identity and encPub for the resulting CID. No creation transaction yet.
 */
export function pinnedTemplateV2(deployer: Hex, over: Partial<TemplateV2> = {}): TemplateV2 {
  const escrow = escrowCreateAddress(lower(deployer))
  const source = UNPINNED_SOURCE_V2.replace(ESCROW_PIN_PLACEHOLDER, `const ESCROW = "${escrow}";`)
  const cid = litActionCid(source)
  const pins = { id: ESCROW_V2.id, cid }
  return {
    ...ESCROW_V2,
    source,
    sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    cid,
    identity: fakeIdentityFor(pins) as Hex,
    encPub: fakeEncPubFor(pins) as TemplateV2['encPub'],
    escrowAddress: escrow,
    escrowDeployer: lower(deployer),
    escrowCreationTx: null,
    ...over,
  }
}

export interface RunbookWorldV2 {
  node: FakeTempoNode
  hosts: HostsConfig
  template: TemplateV2
  deployer: PrivateKeyAccount
}

/** A fresh chain and a pinned V2 template whose escrow is not deployed yet. */
export async function runbookWorldV2(): Promise<RunbookWorldV2> {
  const node = await FakeTempoNode.create()
  const hosts: HostsConfig = {
    fetchImpl: node.fetch as unknown as typeof fetch,
    // A wait lets the chain move on a block, so a lagging host catches up.
    sleep: async () => {
      node.advance(1)
    },
    timeoutMs: 5_000,
  }
  return { node, hosts, template: pinnedTemplateV2(RUNBOOK_DEPLOYER_V2.address), deployer: RUNBOOK_DEPLOYER_V2 }
}

/** The world after step 8 for V2: SalvoEscrowV2 deployed by the scripts' own code, its creation pinned. */
export async function deployedWorldV2(): Promise<RunbookWorldV2 & { deploy: DeployReport }> {
  const w = await runbookWorldV2()
  const deploy = await deployEscrowLive({
    hosts: w.hosts,
    account: w.deployer,
    mode: 'pinned',
    litSigner: w.template.identity,
    template: w.template,
    say: () => {},
  })
  if (!deploy.ok || deploy.txHash === null) throw new Error(`the V2 test deploy failed: ${deploy.stopped ?? 'not ok'}`)
  return { ...w, template: { ...w.template, escrowCreationTx: deploy.txHash }, deploy }
}
