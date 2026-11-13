/**
 * Is the escrow rail ready, and if not, why? (spec section 11, "Readiness")
 *
 * ALWAYS NOT READY UNTIL THE REVIEW. Since 2026-10-10 the escrow is deployed
 * on the Tempo Moderato testnet, the template has run on Lit, and its escrow
 * address, identity, sealing key and the escrow's creation transaction are
 * pinned. The custody review has not happened. `ready` needs the guard to
 * call the escrow backend `non_custodial`, and the guard cannot until that
 * review adds its tag (guard.ts, NON_CUSTODIAL_BACKENDS). So whatever is
 * configured, this says false, and the reasons say why in plain words.
 *
 * Safe to log or serve: names, booleans, counts and public chain addresses
 * (the escrow contract and the token). Never a key, a password, a path or an
 * allowlist entry. Sync and offline: no network call, no database.
 *
 * Reads env directly instead of through the chain registry, because the
 * registry imports src/lib/mpp.ts, which reaches the env module that names
 * the Stripe keys. Nothing on the escrow rail may reach that (spec invariant
 * 12, tests/escrow-no-stripe.test.ts).
 */

import { classifyBackend, type BackendCustody } from '@/lib/vault/guard'
import { CHIPOTLE_ESCROW_BACKEND } from '@/lib/vault/escrow-backend'
import { ESCROW_V1 } from '@/lib/vault/lit/templates'
import { ESCROW_ADDRESS_ENV, ESCROW_CHAIN_KEY, escrowConfig } from './config'
import { escrowPinProblems } from './deployment'
import { PATH_USD } from './manifest'

/**
 * Moderato's USDC.e, which the repo used as the Moderato default until this
 * phase. Uninitialized on chain: `decimals()` reverts with "TIP20 token error:
 * Uninitialized" (measured 2026-10-07). Equal to TEMPO_NETWORKS.moderato.usdc
 * in src/lib/mpp.ts; a test holds them equal, since this file may not import mpp.
 */
const MODERATO_USDC_E = '0x20c000000000000000000000b9537d11c60e8b50'
/** The registry's env name for Moderato's settlement token. */
const CURRENCY_ENV = 'CHAIN_TEMPO_MODERATO_CURRENCY'
const WALLET_ENV = ['WALLET_PASS_TYPE_ID', 'WALLET_TEAM_ID', 'WALLET_P12_PATH', 'WALLET_P12_PASSWORD', 'WALLET_WWDR_PATH'] as const
/** For env input, which is lower-cased before use. Never for a pin: a pin must already be lower-case. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const CODEHASH_RE = /^0x[0-9a-f]{64}$/
const TX_HASH_RE = /^0x[0-9a-f]{64}$/

export type EscrowRailBlocker =
  | 'escrow_rail_off'
  | 'mainnet_refused'
  | 'template_drift'
  | 'codehash_not_pinned'
  | 'identity_not_pinned'
  | 'encpub_not_pinned'
  | 'escrow_not_configured'
  | 'escrow_env_mismatch'
  | 'creation_not_pinned'
  | 'currency_uninitialized'
  | 'currency_not_path_usd'
  | 'custody_not_reviewed'
  | 'wallet_signing_missing'

export interface EscrowRailReadiness {
  ready: boolean
  mode: 'escrow'
  chain: {
    key: typeof ESCROW_CHAIN_KEY
    testnet: true
    /** The escrow the template pins. Public. Null until the lead pins it. */
    escrowAddress: `0x${string}` | null
    /** The token the chain registry would settle in on Moderato. Public. */
    token: `0x${string}`
    tokenIsPathUsd: boolean
  }
  template: {
    id: typeof ESCROW_V1.id
    sha256: string
    cid: string
    intact: boolean
    identityPinned: boolean
    encPubPinned: boolean
    codehashPinned: boolean
    /**
     * The source names one lower-case escrow address, ESCROW_V1 records the
     * same text, and it is the recorded deployer's first CREATE address
     * (escrowPinProblems). A checksummed pin is not pinned: the template
     * compares text, so it would refuse every manifest.
     */
    escrowPinned: boolean
    /**
     * ESCROW_V1 records the escrow's creation transaction. Recorded, not
     * verified: verifyEscrowCreation runs live (escrow:deploy, escrow:check,
     * custody review condition 2). Readiness cannot read the chain.
     */
    creationPinned: boolean
  }
  custody: BackendCustody
  litUsageKeyPresent: boolean
  keeperKeyPresent: boolean
  /** All five WALLET_ settings are set. Passes need it; the on-screen code does not. */
  walletSigning: boolean
  sellerAllowlistSize: number
  /** Env names the rail needs and does not have. */
  missing: string[]
  blockers: EscrowRailBlocker[]
  reasons: string[]
}

type Env = Readonly<Record<string, string | undefined>>

const envValue = (env: Env, name: string): string => (env[name] ?? '').trim()

const REASONS: Record<EscrowRailBlocker, string> = {
  escrow_rail_off: 'The escrow rail is off. ESCROW_RAIL=testnet turns it on.',
  mainnet_refused: 'ESCROW_RAIL asks for mainnet. This build runs the escrow on the Tempo Moderato testnet only.',
  template_drift:
    "The escrow template's text no longer matches its pinned hash. Lit would give it a different key, so no listing could open.",
  codehash_not_pinned: "The escrow template does not pin the compiled contract's code hash.",
  identity_not_pinned:
    "The escrow template's signer address is not pinned yet. It comes from the first live bind run on Lit.",
  encpub_not_pinned:
    "The escrow template's sealing key is not pinned yet, so a seller's page has nothing to seal a card to.",
  escrow_not_configured:
    "The escrow template does not name its contract's address. That is the deployer's first contract address, in lower case, pinned before the template is frozen.",
  escrow_env_mismatch: `${ESCROW_ADDRESS_ENV} names a contract the escrow template does not trust. Leave it unset or set it to the pinned address.`,
  creation_not_pinned:
    "The escrow's creation transaction is not pinned yet. A reviewer checks it ran the plain compiled code, because the code alone says nothing about the storage it started with.",
  currency_uninitialized: `${CURRENCY_ENV} names Moderato's USDC.e, which is not set up on chain. Leave it unset to use pathUSD.`,
  currency_not_path_usd: `${CURRENCY_ENV} names a token other than pathUSD. The escrow takes pathUSD only.`,
  custody_not_reviewed:
    "The escrow has not passed the custody review, so the guard does not count it as non-custodial. On the testnet a listing is taken as the operator's own card. The live testnet run passed on 2026-10-10.",
  wallet_signing_missing:
    'Apple Wallet passes cannot be signed: one or more WALLET_ settings are missing. Cards can still show on screen.',
}

/** ESCROW_RAIL: only the exact word `testnet` turns the rail on. */
function railSetting(env: Env): 'on' | 'off' | 'mainnet' {
  const raw = envValue(env, 'ESCROW_RAIL').toLowerCase()
  if (raw === 'testnet') return 'on'
  if (raw === 'mainnet' || raw === 'production' || raw === 'live') return 'mainnet'
  return 'off'
}

/** Moderato's settlement token as the registry resolves it: a valid env address, else pathUSD. */
function registryToken(env: Env): `0x${string}` {
  const raw = envValue(env, CURRENCY_ENV)
  return ADDRESS_RE.test(raw) ? (raw.toLowerCase() as `0x${string}`) : PATH_USD
}

/** Distinct valid addresses in ESCROW_SELLER_ALLOWLIST, and whether anything else was there. */
function allowlist(env: Env): { size: number; junk: boolean } {
  const parts = envValue(env, 'ESCROW_SELLER_ALLOWLIST')
    .split(/[\s,]+/)
    .filter((p) => p !== '')
  const valid = new Set(parts.filter((p) => ADDRESS_RE.test(p)).map((p) => p.toLowerCase()))
  return { size: valid.size, junk: parts.some((p) => !ADDRESS_RE.test(p)) }
}

/**
 * The escrow rail's readiness report.
 *
 * `ready` is true only when the rail is on, every pin is set, the contract is
 * configured, every needed setting is present and the guard calls the escrow
 * backend non-custodial. Missing Wallet signing is reported but does not block
 * `ready`: it stops passes, not purchases.
 *
 * GET /api/health serves it as `config.escrow`, next to sellerOnboarding, so
 * an operator sees every blocker (a mismatched address env, a missing Lit
 * usage key or keeper key, an empty test list) where they already look.
 */
export function escrowRailReadiness(env: Env = process.env): EscrowRailReadiness {
  const cfg = escrowConfig()
  const rail = railSetting(env)
  const token = registryToken(env)
  const custody = classifyBackend(CHIPOTLE_ESCROW_BACKEND)
  const codehashPinned =
    CODEHASH_RE.test(cfg.template.escrowCodehash) &&
    ESCROW_V1.source.includes(`const ESCROW_CODEHASH = "${cfg.template.escrowCodehash}";`)
  const escrowPinned = escrowPinProblems(ESCROW_V1).length === 0
  const creationPinned = TX_HASH_RE.test(ESCROW_V1.escrowCreationTx ?? '')
  // The registry's env name for the address is not how the rail finds its
  // escrow, but other code reads it, so it must not point anywhere else.
  const envEscrow = envValue(env, ESCROW_ADDRESS_ENV)
  const envMismatch = envEscrow !== '' && (!escrowPinned || envEscrow.toLowerCase() !== cfg.escrowAddress)
  const litUsageKeyPresent = envValue(env, 'LIT_VAULT_USAGE_KEY') !== ''
  const keeperKeyPresent = envValue(env, 'ESCROW_KEEPER_KEY') !== ''
  const walletSigning = WALLET_ENV.every((name) => envValue(env, name) !== '')
  const sellers = allowlist(env)

  const blockers: EscrowRailBlocker[] = []
  if (rail === 'off') blockers.push('escrow_rail_off')
  if (rail === 'mainnet') blockers.push('mainnet_refused')
  if (!cfg.template.intact) blockers.push('template_drift')
  if (!codehashPinned) blockers.push('codehash_not_pinned')
  if (cfg.template.identity === null) blockers.push('identity_not_pinned')
  if (cfg.template.encPub === null) blockers.push('encpub_not_pinned')
  if (!escrowPinned) blockers.push('escrow_not_configured')
  if (envMismatch) blockers.push('escrow_env_mismatch')
  if (!creationPinned) blockers.push('creation_not_pinned')
  if (token === MODERATO_USDC_E) blockers.push('currency_uninitialized')
  else if (token !== PATH_USD) blockers.push('currency_not_path_usd')
  if (custody !== 'non_custodial') blockers.push('custody_not_reviewed')
  if (!walletSigning) blockers.push('wallet_signing_missing')

  const missing: string[] = []
  if (!litUsageKeyPresent) missing.push('LIT_VAULT_USAGE_KEY')
  if (!keeperKeyPresent) missing.push('ESCROW_KEEPER_KEY')
  if (sellers.size === 0) missing.push('ESCROW_SELLER_ALLOWLIST')

  const reasons = blockers.map((b) => REASONS[b])
  if (sellers.junk) reasons.push('ESCROW_SELLER_ALLOWLIST has entries that are not addresses. They are ignored.')

  const blocking = blockers.filter((b) => b !== 'wallet_signing_missing')
  return {
    ready: custody === 'non_custodial' && blocking.length === 0 && missing.length === 0,
    mode: 'escrow',
    chain: {
      key: cfg.chain.key,
      testnet: cfg.chain.testnet,
      escrowAddress: cfg.escrowAddress,
      token,
      tokenIsPathUsd: token === PATH_USD,
    },
    template: {
      id: cfg.template.id,
      sha256: cfg.template.sha256,
      cid: cfg.template.cid,
      intact: cfg.template.intact,
      identityPinned: cfg.template.identity !== null,
      encPubPinned: cfg.template.encPub !== null,
      codehashPinned,
      escrowPinned,
      creationPinned,
    },
    custody,
    litUsageKeyPresent,
    keeperKeyPresent,
    walletSigning,
    sellerAllowlistSize: sellers.size,
    missing,
    blockers,
    reasons,
  }
}
