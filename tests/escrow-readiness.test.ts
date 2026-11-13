/**
 * escrowRailReadiness: the escrow rail's answer to "can it run, and if not, why".
 *
 * Phase 1 pins one thing above all: `ready` is false whatever is configured,
 * because the custody review has not happened and the guard calls the escrow
 * backend `unknown`. Then each blocker in turn, the env names it reports, and
 * that no secret value (a key, a password, a path, an allowlist entry) ever
 * reaches the output. Public chain addresses (the escrow, the token) may.
 *
 * The committed template is fully pinned since 2026-10-10 (the live deploy on
 * Moderato and the live bind on Lit), and a block below holds readiness to
 * that. Template states this build no longer reaches on its own (unpinned,
 * pinned to a test escrow, drifted) are made by replacing ESCROW_V1 for one
 * import graph with vi.doMock. unpinnedTemplate rebuilds the template as it
 * was before the pin step, so the blockers for a missing pin stay under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { chainConfig } from '@/lib/chains/registry'
import { PATH_USD } from '@/lib/escrow/manifest'
import { escrowRailReadiness, type EscrowRailReadiness } from '@/lib/escrow/readiness'
import { TEMPO_NETWORKS } from '@/lib/mpp'
import { ESCROW_V1, templateIntegrity, type EscrowTemplate } from '@/lib/vault/lit/templates'
import { ESCROW_PIN_PLACEHOLDER, escrowCreateAddress, escrowPinProblems } from '@/lib/escrow/deployment'

/** What the live runs of 2026-10-10 pinned: the escrow on Moderato, its deployer and creation, and the bind. */
const LIVE = {
  escrowAddress: '0x75c9aabe8254559f865e14d6e5fa70c738869bef',
  escrowDeployer: '0xe11390d43bce5245789736096df41184d5b07f46',
  escrowCreationTx: '0xfe06c77078991aa4ca6493cf1d21c43f356ef53022b8498b78da7ebcd34dcdf4',
  identity: '0x9109cd47811a9fc64c88316d64954b6b228d2cfe',
  encPub: '0x034580968471306568d23fc9e56127394b53a414e8b272f82d1f72a6e2adccda24',
} as const

/** The pin's deployer. The pin must be its first CREATE address. */
const DEPLOYER = '0x5a170000000000000000000000000000000000e1'
const PINNED = escrowCreateAddress(DEPLOYER)
/** The same address checksummed, as an env value might hold it. */
const ESCROW_ADDRESS = getAddress(PINNED)
const CREATION_TX = `0x${'c5'.repeat(32)}` as const
const SECRETS = {
  LIT_VAULT_USAGE_KEY: 'uk-escrow-readiness-secret',
  ESCROW_KEEPER_KEY: 'kk-escrow-readiness-secret',
  ESCROW_SELLER_ALLOWLIST: '0x5a170000000000000000000000000000000000a1, 0x5A170000000000000000000000000000000000B2',
  WALLET_PASS_TYPE_ID: 'pass.readiness.secret',
  WALLET_TEAM_ID: 'TEAMSECRET9',
  WALLET_P12_PATH: 'C:/secret-dir/readiness.p12',
  WALLET_P12_PASSWORD: 'p12-readiness-secret',
  WALLET_WWDR_PATH: 'C:/secret-dir/wwdr-readiness.pem',
}
const FULL: Record<string, string> = {
  ESCROW_RAIL: 'testnet',
  ...SECRETS,
}

function expectNoSecrets(r: EscrowRailReadiness): void {
  const text = JSON.stringify(r)
  for (const [name, value] of Object.entries(SECRETS)) {
    for (const part of value.split(/[\s,]+/).filter((p) => p !== '')) {
      expect(text, name).not.toContain(part)
      expect(text.toLowerCase(), name).not.toContain(part.toLowerCase())
    }
  }
}

/** escrowRailReadiness with ESCROW_V1 replaced for this one import graph. */
async function readinessWithTemplate(
  change: (real: EscrowTemplate) => EscrowTemplate,
): Promise<typeof escrowRailReadiness> {
  vi.resetModules()
  vi.doMock('@/lib/vault/lit/templates', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/lib/vault/lit/templates')>()
    return { ...real, ESCROW_V1: Object.freeze(change(real.ESCROW_V1)) }
  })
  return (await import('@/lib/escrow/readiness')).escrowRailReadiness
}

/**
 * ESCROW_V1 as it was before the pin step: the source's ESCROW line is the
 * placeholder again, its sha256 and CID are those bytes' own (so it is
 * intact), and nothing is pinned: no escrow, deployer, creation transaction,
 * identity or sealing key.
 */
function unpinnedTemplate(t: EscrowTemplate): EscrowTemplate {
  const source = t.source.replace(/\nconst ESCROW = "[^"\n]*";\n/, `\n${ESCROW_PIN_PLACEHOLDER}\n`)
  if (source.split(ESCROW_PIN_PLACEHOLDER).length !== 2) throw new Error('unpinnedTemplate: no single ESCROW line to put the placeholder back in')
  const { sha256, cid } = templateIntegrity({ source, sha256: '', cid: '' })
  return {
    ...t,
    source,
    sha256,
    cid,
    escrowAddress: null,
    escrowDeployer: null,
    escrowCreationTx: null,
    identity: null,
    encPub: null,
  }
}

/**
 * The unpinned template as a pin step to a test escrow leaves it: the source
 * names `pin` (PINNED by default), the record says the same with its
 * deployer, and the pins are the new bytes' own, so the template is intact.
 * Identity, sealing key and creation transaction stay unpinned.
 */
function pinnedTemplate(t: EscrowTemplate, pin: string = PINNED, deployer: `0x${string}` = DEPLOYER): EscrowTemplate {
  const unpinned = unpinnedTemplate(t)
  const source = unpinned.source.replace(ESCROW_PIN_PLACEHOLDER, `const ESCROW = "${pin}";`)
  const { sha256, cid } = templateIntegrity({ source, sha256: '', cid: '' })
  return { ...unpinned, source, sha256, cid, escrowAddress: pin as `0x${string}`, escrowDeployer: deployer }
}

afterEach(() => {
  vi.doUnmock('@/lib/vault/lit/templates')
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('the committed build, pinned live on 2026-10-10', () => {
  it('the committed ESCROW_V1 is intact and fully pinned', () => {
    expect(templateIntegrity(ESCROW_V1).intact).toBe(true)
    expect(escrowPinProblems(ESCROW_V1)).toEqual([])
    expect(ESCROW_V1.source.split('\n')).toContain(`const ESCROW = "${LIVE.escrowAddress}";`)
    expect(escrowCreateAddress(LIVE.escrowDeployer)).toBe(LIVE.escrowAddress)
    expect({
      escrowAddress: ESCROW_V1.escrowAddress,
      escrowDeployer: ESCROW_V1.escrowDeployer,
      escrowCreationTx: ESCROW_V1.escrowCreationTx,
      identity: ESCROW_V1.identity,
      encPub: ESCROW_V1.encPub,
    }).toEqual(LIVE)
  })

  it('an empty environment: only the rail switch, the review and Wallet signing are left', () => {
    const r = escrowRailReadiness({})
    expect(r.ready).toBe(false)
    expect(r.mode).toBe('escrow')
    expect(r.blockers).toEqual(['escrow_rail_off', 'custody_not_reviewed', 'wallet_signing_missing'])
    expect(r.reasons).toHaveLength(3)
    expect(r.missing).toEqual(['LIT_VAULT_USAGE_KEY', 'ESCROW_KEEPER_KEY', 'ESCROW_SELLER_ALLOWLIST'])
    expect(r.chain).toEqual({
      key: 'tempo-moderato',
      testnet: true,
      escrowAddress: LIVE.escrowAddress,
      token: PATH_USD,
      tokenIsPathUsd: true,
    })
    expect(r.template).toEqual({
      id: 'salvo-vault-escrow/1',
      sha256: ESCROW_V1.sha256,
      cid: ESCROW_V1.cid,
      intact: true,
      identityPinned: true,
      encPubPinned: true,
      codehashPinned: true,
      escrowPinned: true,
      creationPinned: true,
    })
    expect(r.custody).toBe('unknown')
  })

  it('everything configured is still not ready: the only blocker left is the review', () => {
    for (const v of [undefined, LIVE.escrowAddress, getAddress(LIVE.escrowAddress)]) {
      const env = v === undefined ? FULL : { ...FULL, CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS: v }
      const r = escrowRailReadiness(env)
      expect(r.ready, String(v)).toBe(false)
      expect(r.blockers, String(v)).toEqual(['custody_not_reviewed'])
      expect(r.missing).toEqual([])
      expect(r.chain.escrowAddress).toBe(LIVE.escrowAddress)
      expectNoSecrets(r)
    }
    // Any other contract in the registry env is still flagged against the live pin.
    const other = escrowRailReadiness({ ...FULL, CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS: ESCROW_ADDRESS })
    expect(other.blockers).toEqual(['escrow_env_mismatch', 'custody_not_reviewed'])
  })
})

describe('escrow readiness, Phase 1', () => {
  it('an empty environment, unpinned: off, unpinned, undeployed, unreviewed', async () => {
    const readiness = await readinessWithTemplate(unpinnedTemplate)
    const unpinned = unpinnedTemplate(ESCROW_V1)
    const r = readiness({})
    expect(r.ready).toBe(false)
    expect(r.mode).toBe('escrow')
    expect(r.blockers).toEqual([
      'escrow_rail_off',
      'identity_not_pinned',
      'encpub_not_pinned',
      'escrow_not_configured',
      'creation_not_pinned',
      'custody_not_reviewed',
      'wallet_signing_missing',
    ])
    expect(r.missing).toEqual(['LIT_VAULT_USAGE_KEY', 'ESCROW_KEEPER_KEY', 'ESCROW_SELLER_ALLOWLIST'])
    expect(r.chain).toEqual({
      key: 'tempo-moderato',
      testnet: true,
      escrowAddress: null,
      token: PATH_USD,
      tokenIsPathUsd: true,
    })
    expect(r.template).toEqual({
      id: 'salvo-vault-escrow/1',
      sha256: unpinned.sha256,
      cid: unpinned.cid,
      intact: true,
      identityPinned: false,
      encPubPinned: false,
      codehashPinned: true,
      escrowPinned: false,
      creationPinned: false,
    })
    expect(r.custody).toBe('unknown')
    expect(r.litUsageKeyPresent).toBe(false)
    expect(r.keeperKeyPresent).toBe(false)
    expect(r.walletSigning).toBe(false)
    expect(r.sellerAllowlistSize).toBe(0)
  })

  it('everything configured is still not ready: config cannot pin a template or pass a custody review', async () => {
    const readiness = await readinessWithTemplate(unpinnedTemplate)
    const r = readiness(FULL)
    expect(r.ready).toBe(false)
    expect(r.blockers).toEqual([
      'identity_not_pinned',
      'encpub_not_pinned',
      'escrow_not_configured',
      'creation_not_pinned',
      'custody_not_reviewed',
    ])
    expect(r.missing).toEqual([])
    expect(r.custody).toBe('unknown')
    expect(r.chain.escrowAddress).toBeNull()
    expect(r.litUsageKeyPresent).toBe(true)
    expect(r.keeperKeyPresent).toBe(true)
    expect(r.walletSigning).toBe(true)
    expect(r.sellerAllowlistSize).toBe(2)
    expectNoSecrets(r)
  })

  it('every pin set and everything configured: the only blocker left is the review', async () => {
    const readiness = await readinessWithTemplate((t) => ({
      ...pinnedTemplate(t),
      identity: '0x5a170000000000000000000000000000000000c3',
      encPub: `0x02${'c4'.repeat(32)}` as const,
      escrowCreationTx: CREATION_TX,
    }))
    const r = readiness({ ...FULL, CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS: ESCROW_ADDRESS })
    expect(r.template.identityPinned).toBe(true)
    expect(r.template.encPubPinned).toBe(true)
    expect(r.template.escrowPinned).toBe(true)
    expect(r.template.creationPinned).toBe(true)
    expect(r.template.intact).toBe(true)
    expect(r.chain.escrowAddress).toBe(PINNED)
    expect(r.blockers).toEqual(['custody_not_reviewed'])
    expect(r.ready).toBe(false)
    expectNoSecrets(r)
  })

  it('says why in plain words, one reason per blocker, no values', async () => {
    const readiness = await readinessWithTemplate(unpinnedTemplate)
    for (const r of [readiness({}), escrowRailReadiness({})]) {
      expect(r.reasons).toHaveLength(r.blockers.length)
      for (const reason of r.reasons) {
        expect(reason).not.toMatch(/[\u2014\u2013]/)
        expect(reason.length).toBeLessThan(240)
      }
      expect(r.reasons[r.blockers.indexOf('custody_not_reviewed')]).toMatch(/custody review/)
    }
    const r = readiness({})
    expect(r.reasons[r.blockers.indexOf('escrow_not_configured')]).toMatch(/does not name its contract's address/)
  })
})

describe('each blocker', () => {
  it('escrow_rail_off: only the word testnet turns the rail on', () => {
    for (const v of ['', 'off', 'OFF', 'on', 'true', 'testnetx', 'moderato']) {
      expect(escrowRailReadiness({ ...FULL, ESCROW_RAIL: v }).blockers, v).toContain('escrow_rail_off')
    }
    const { ESCROW_RAIL: _unset, ...noRail } = FULL
    expect(escrowRailReadiness(noRail).blockers).toContain('escrow_rail_off')
    for (const v of ['testnet', ' TestNet ']) {
      expect(escrowRailReadiness({ ...FULL, ESCROW_RAIL: v }).blockers, v).not.toContain('escrow_rail_off')
    }
  })

  it('mainnet_refused: asking for mainnet is refused, not treated as on', () => {
    for (const v of ['mainnet', 'MAINNET', 'production', 'live']) {
      const r = escrowRailReadiness({ ...FULL, ESCROW_RAIL: v })
      expect(r.blockers, v).toContain('mainnet_refused')
      expect(r.blockers, v).not.toContain('escrow_rail_off')
      expect(r.ready).toBe(false)
    }
  })

  it('escrow_not_configured: the template names no escrow, whatever env says', async () => {
    const readiness = await readinessWithTemplate(unpinnedTemplate)
    for (const v of [undefined, '', ESCROW_ADDRESS, LIVE.escrowAddress]) {
      const env = v === undefined ? FULL : { ...FULL, CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS: v }
      const r = readiness(env)
      expect(r.blockers, String(v)).toContain('escrow_not_configured')
      expect(r.template.escrowPinned).toBe(false)
      expect(r.chain.escrowAddress).toBeNull()
      // The env name is not a setting the rail needs.
      expect(r.missing, String(v)).not.toContain('CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS')
    }
    expect(readiness({}).reasons.join(' ')).not.toMatch(/0x5a17/i)
  })

  it('escrow_not_configured: a recorded address the source does not name is not a pin', async () => {
    // The placeholder source with a record claiming PINNED, and the committed
    // source (which names the live escrow) with a record claiming PINNED.
    for (const base of [unpinnedTemplate, (t: EscrowTemplate) => t]) {
      const readiness = await readinessWithTemplate((t) => ({ ...base(t), escrowAddress: PINNED, escrowDeployer: DEPLOYER }))
      const r = readiness(FULL)
      expect(r.template.escrowPinned).toBe(false)
      expect(r.blockers).toContain('escrow_not_configured')
    }
  })

  it('escrow_not_configured: a checksummed pin is not a pin, even when the source and the record agree', async () => {
    // The template compares the manifest's lower-case escrow with its pin as
    // text, so this pin would refuse every listing. Readiness must not call it pinned.
    const readiness = await readinessWithTemplate((t) => pinnedTemplate(t, ESCROW_ADDRESS))
    const r = readiness(FULL)
    expect(ESCROW_ADDRESS).not.toBe(PINNED)
    expect(r.template.intact).toBe(true)
    expect(r.template.escrowPinned).toBe(false)
    expect(r.blockers).toContain('escrow_not_configured')
  })

  it("escrow_not_configured: a pin that is not the recorded deployer's first contract address", async () => {
    for (const deployer of ['0x5a170000000000000000000000000000000000e2', DEPLOYER.toUpperCase().replace('0X', '0x')] as const) {
      const readiness = await readinessWithTemplate((t) => pinnedTemplate(t, PINNED, deployer as `0x${string}`))
      const r = readiness(FULL)
      expect(r.template.escrowPinned, deployer).toBe(false)
      expect(r.blockers, deployer).toContain('escrow_not_configured')
    }
    const missing = await readinessWithTemplate((t) => ({ ...pinnedTemplate(t), escrowDeployer: null }))
    expect(missing(FULL).template.escrowPinned).toBe(false)
  })

  it('creation_not_pinned: until the creation transaction is recorded as a full hash', async () => {
    for (const [tx, pinned] of [
      [null, false],
      ['0x12', false],
      [`0x${'C5'.repeat(32)}`, false],
      [CREATION_TX, true],
    ] as const) {
      const readiness = await readinessWithTemplate((t) => ({ ...pinnedTemplate(t), escrowCreationTx: tx as `0x${string}` | null }))
      const r = readiness(FULL)
      expect(r.template.escrowPinned, String(tx)).toBe(true)
      expect(r.template.creationPinned, String(tx)).toBe(pinned)
      expect(r.blockers.includes('creation_not_pinned'), String(tx)).toBe(!pinned)
      expect(JSON.stringify(r)).not.toContain('c5c5c5')
    }
    const unpinned = (await readinessWithTemplate(unpinnedTemplate))({})
    expect(unpinned.reasons[unpinned.blockers.indexOf('creation_not_pinned')]).toMatch(/creation transaction/)
  })

  it('escrow_env_mismatch: the registry env names another contract than the pin', async () => {
    // Unpinned: any address there names a contract the template does not trust.
    const unpinned = await readinessWithTemplate(unpinnedTemplate)
    for (const v of [ESCROW_ADDRESS, LIVE.escrowAddress]) {
      expect(unpinned({ ...FULL, CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS: v }).blockers, v).toContain('escrow_env_mismatch')
    }
    expect(unpinned(FULL).blockers).not.toContain('escrow_env_mismatch')
    const readiness = await readinessWithTemplate(pinnedTemplate)
    for (const [v, mismatch] of [
      [undefined, false],
      ['', false],
      [ESCROW_ADDRESS, false],
      [PINNED, false],
      ['0x5a1700000000000000000000000000000000000a', true],
      ['nope', true],
    ] as const) {
      const env = v === undefined ? FULL : { ...FULL, CHAIN_TEMPO_MODERATO_ESCROW_ADDRESS: v }
      const r = readiness(env)
      expect(r.blockers.includes('escrow_env_mismatch'), String(v)).toBe(mismatch)
      expect(r.blockers).not.toContain('escrow_not_configured')
      expect(JSON.stringify(r)).not.toContain('0x5a1700000000000000000000000000000000000a')
    }
  })

  it("currency_uninitialized: the registry's old Moderato default, USDC.e", () => {
    for (const v of [TEMPO_NETWORKS.moderato.usdc, TEMPO_NETWORKS.moderato.usdc.toUpperCase().replace('0X', '0x')]) {
      const r = escrowRailReadiness({ ...FULL, CHAIN_TEMPO_MODERATO_CURRENCY: v })
      expect(r.blockers).toContain('currency_uninitialized')
      expect(r.blockers).not.toContain('currency_not_path_usd')
      expect(r.chain.tokenIsPathUsd).toBe(false)
    }
  })

  it('currency_not_path_usd: a token other than pathUSD or USDC.e', () => {
    const r = escrowRailReadiness({ ...FULL, CHAIN_TEMPO_MODERATO_CURRENCY: '0x5a170000000000000000000000000000000000d5' })
    expect(r.blockers).toContain('currency_not_path_usd')
    expect(r.blockers).not.toContain('currency_uninitialized')
  })

  it('the currency defaults to pathUSD, as the chain registry now does', () => {
    for (const v of [undefined, '', 'not-an-address', PATH_USD]) {
      const env = v === undefined ? FULL : { ...FULL, CHAIN_TEMPO_MODERATO_CURRENCY: v }
      const r = escrowRailReadiness(env)
      expect(r.chain.token).toBe(PATH_USD)
      expect(r.chain.tokenIsPathUsd).toBe(true)
      expect(r.blockers).not.toContain('currency_uninitialized')
    }
    const prev = process.env.CHAIN_TEMPO_MODERATO_CURRENCY
    delete process.env.CHAIN_TEMPO_MODERATO_CURRENCY
    try {
      expect(chainConfig('tempo-moderato').currency).toBe(PATH_USD)
      expect(TEMPO_NETWORKS.moderato.pathUsd).toBe(PATH_USD)
    } finally {
      if (prev !== undefined) process.env.CHAIN_TEMPO_MODERATO_CURRENCY = prev
    }
  })

  it('wallet_signing_missing: one of the five WALLET_ settings is blank', () => {
    for (const name of ['WALLET_PASS_TYPE_ID', 'WALLET_TEAM_ID', 'WALLET_P12_PATH', 'WALLET_P12_PASSWORD', 'WALLET_WWDR_PATH']) {
      const r = escrowRailReadiness({ ...FULL, [name]: '  ' })
      expect(r.walletSigning, name).toBe(false)
      expect(r.blockers, name).toContain('wallet_signing_missing')
      // It stops passes, not purchases, so it is not a missing rail setting.
      expect(r.missing, name).toEqual([])
    }
  })

  it('missing settings are named, never shown', () => {
    for (const name of ['LIT_VAULT_USAGE_KEY', 'ESCROW_KEEPER_KEY', 'ESCROW_SELLER_ALLOWLIST']) {
      const r = escrowRailReadiness({ ...FULL, [name]: '' })
      expect(r.missing).toEqual([name])
      expectNoSecrets(r)
    }
  })

  it('the seller allowlist counts distinct addresses and ignores the rest', () => {
    const r = escrowRailReadiness({
      ...FULL,
      ESCROW_SELLER_ALLOWLIST: '0x5a170000000000000000000000000000000000a1,0x5A170000000000000000000000000000000000A1 junk-entry-secret',
    })
    expect(r.sellerAllowlistSize).toBe(1)
    expect(r.reasons.join(' ')).toMatch(/not addresses/)
    expect(JSON.stringify(r)).not.toContain('junk-entry-secret')
    expect(escrowRailReadiness({ ...FULL, ESCROW_SELLER_ALLOWLIST: 'junk' }).missing).toEqual(['ESCROW_SELLER_ALLOWLIST'])
  })

  it('custody_not_reviewed: present in every environment this phase', () => {
    for (const env of [{}, FULL, { ...FULL, ESCROW_RAIL: 'mainnet' }]) {
      const r = escrowRailReadiness(env)
      expect(r.blockers).toContain('custody_not_reviewed')
      expect(r.custody).not.toBe('non_custodial')
      expect(r.ready).toBe(false)
    }
  })

  it('identity_not_pinned and encpub_not_pinned: until the live bind is pinned', async () => {
    const both = (await readinessWithTemplate(unpinnedTemplate))(FULL)
    expect(both.template.identityPinned).toBe(false)
    expect(both.template.encPubPinned).toBe(false)
    expect(both.blockers).toContain('identity_not_pinned')
    expect(both.blockers).toContain('encpub_not_pinned')
    // One without the other is still a blocker for the missing one.
    const keyOnly = (await readinessWithTemplate((t) => ({ ...pinnedTemplate(t), encPub: LIVE.encPub })))(FULL)
    expect(keyOnly.blockers).toContain('identity_not_pinned')
    expect(keyOnly.blockers).not.toContain('encpub_not_pinned')
    const signerOnly = (await readinessWithTemplate((t) => ({ ...pinnedTemplate(t), identity: LIVE.identity })))(FULL)
    expect(signerOnly.blockers).not.toContain('identity_not_pinned')
    expect(signerOnly.blockers).toContain('encpub_not_pinned')
    // The committed build has both, from the live bind.
    const committed = escrowRailReadiness(FULL)
    expect(committed.template.identityPinned).toBe(true)
    expect(committed.template.encPubPinned).toBe(true)
    expect(committed.blockers).not.toContain('identity_not_pinned')
    expect(committed.blockers).not.toContain('encpub_not_pinned')
  })

  it('template_drift: a template that no longer hashes to its pins', async () => {
    const readiness = await readinessWithTemplate((t) => ({ ...t, source: `${t.source}\n` }))
    const r = readiness(FULL)
    expect(r.template.intact).toBe(false)
    expect(r.blockers).toContain('template_drift')
    expect(r.ready).toBe(false)
  })

  it('codehash_not_pinned: the pin and the source disagree', async () => {
    const readiness = await readinessWithTemplate((t) => ({ ...t, escrowCodehash: `0x${'ee'.repeat(32)}` }))
    const r = readiness(FULL)
    expect(r.template.intact).toBe(true)
    expect(r.template.codehashPinned).toBe(false)
    expect(r.blockers).toContain('codehash_not_pinned')
  })
})

describe('offline and stable', () => {
  it('makes no network call and gives the same answer twice', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('readiness must not fetch')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const a = escrowRailReadiness(FULL)
    const b = escrowRailReadiness(FULL)
    expect(a).toEqual(b)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reads the env it is given, not process.env, when one is passed', () => {
    const prev = process.env.ESCROW_RAIL
    process.env.ESCROW_RAIL = 'testnet'
    try {
      expect(escrowRailReadiness({}).blockers).toContain('escrow_rail_off')
    } finally {
      if (prev === undefined) delete process.env.ESCROW_RAIL
      else process.env.ESCROW_RAIL = prev
    }
  })
})
