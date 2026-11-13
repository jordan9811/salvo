/**
 * Where the escrow lives, and the check that it is the honest deployment
 * (src/lib/escrow/deployment.ts). In-process EVM, no network.
 *
 * The template trusts one escrow by address and runtime code hash. Neither
 * covers storage, and the deployer chooses the init code that runs at the
 * pinned address. The attack test below runs that for real: init code that
 * presets `owed[attacker]` and then returns SalvoEscrowV1's exact runtime.
 * Every read a reviewer could make of the deployed contract (code hash,
 * litSigner, token, gate) matches the honest one, and the attacker still
 * takes a shopper's deposit. Only the creation transaction shows it, and
 * verifyEscrowCreation is the check that reads it.
 *
 * Also pinned: the order that keeps the address reachable. The pin is the
 * deployer's nonce-0 CREATE address, lower-case, recorded with its deployer;
 * a deploy is refused from any other key or after any other transaction.
 */

import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, getAddress, keccak256, maxUint256, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ESCROW_ABI, ESCROW_RUNTIME_BYTECODE, RUNTIME_KECCAK } from '@/lib/escrow/artifact'
import {
  ESCROW_PIN_PLACEHOLDER,
  checkEscrowDeployPreflight,
  escrowCreateAddress,
  escrowCreationInput,
  escrowPinProblems,
  verifyEscrowCreation,
  type EscrowCreationReceipt,
  type EscrowCreationTx,
} from '@/lib/escrow/deployment'
import { ESCROW_V1 } from '@/lib/vault/lit/templates'
import { TestChain, testAddress } from './support/evm'
import {
  DEPOSIT_OPENED,
  MOCK_TOKEN_ABI,
  commitmentOf,
  deployMockToken,
  escrowCall,
  escrowInitCode,
  listingIdOf,
  readerFor,
  signTicket,
  tokenCall,
  type Terms,
} from './support/escrow-chain'

const LIT = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const FUNDER = testAddress(1)
const SELLER = testAddress(2)
const BUYER = testAddress(3)
const STRANGER = testAddress(4)
const DEPLOYER = testAddress(40)
const ATTACKER = testAddress(66)
const PIN = escrowCreateAddress(DEPLOYER)
const T0 = 1_790_000_000n
const PRICE = 4_400_000n
const TX_HASH: Hex = `0x${'7e'.repeat(32)}`
/** SalvoEscrowV1's storage slots: litSigner 0, token 1, depositCount 2, _lock 3, ..., owed 9. */
const SLOT_SIGNER = 0n
const SLOT_TOKEN = 1n
const SLOT_LOCK = 3n
const SLOT_OWED = 9n

const lower = (a: string): Hex => a.toLowerCase() as Hex
/** The committed template with its ESCROW line set back to the placeholder: the unpinned bytes, in either state. */
const UNPINNED_SOURCE = ESCROW_V1.source.replace(/\nconst ESCROW = "[^"\n]*";\n/, `\n${ESCROW_PIN_PLACEHOLDER}\n`)
/** Those bytes with the ESCROW line set to `pin`, as the pin step writes it. */
const sourcePinnedTo = (pin: string): string => UNPINNED_SOURCE.replace(ESCROW_PIN_PLACEHOLDER, `const ESCROW = "${pin}";`)
const word = (n: bigint): string => n.toString(16).padStart(64, '0')
const u16 = (n: number): string => n.toString(16).padStart(4, '0')

/**
 * Init code that writes `stores` (slot, value) and then returns `runtime`:
 * SSTORE each, then CODECOPY the runtime from after this prefix and RETURN it.
 */
function doctoredInit(stores: ReadonlyArray<readonly [bigint, bigint]>, runtime: Hex): Hex {
  const writes = stores.map(([slot, value]) => `7f${word(value)}7f${word(slot)}55`).join('')
  const size = (runtime.length - 2) / 2
  const tailBytes = 15 // PUSH2 size, PUSH2 offset, PUSH1 0, CODECOPY, PUSH2 size, PUSH1 0, RETURN
  const offset = writes.length / 2 + tailBytes
  const tail = `61${u16(size)}61${u16(offset)}600039${'61'}${u16(size)}6000f3`
  return `0x${writes}${tail}${runtime.slice(2)}`
}

const owedSlot = (who: Hex): bigint => BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, SLOT_OWED])))

/** A chain with a 6-decimal token, a funded buyer, and nothing from DEPLOYER yet. */
async function chainWithToken(): Promise<{ chain: TestChain; token: Hex }> {
  const chain = await TestChain.create({ timestamp: T0 })
  const token = await deployMockToken(chain, FUNDER)
  const r = await chain.send(FUNDER, token, tokenCall.mint(BUYER, 1_000_000_000n))
  if (!r.ok) throw new Error('mint failed')
  return { chain, token }
}

function creationTx(input: Hex, over: Partial<EscrowCreationTx> = {}): EscrowCreationTx {
  return { hash: TX_HASH, from: DEPLOYER, to: null, nonce: 0, input, type: 'eip1559', ...over }
}

function receiptOf(address: Hex | null, over: Partial<EscrowCreationReceipt> = {}): EscrowCreationReceipt {
  return { transactionHash: TX_HASH, status: 'success', contractAddress: address, ...over }
}

/** The shopper buys one listing at `escrow`: list, a litSigner ticket, approve and depositAndOpen. */
async function buyOne(chain: TestChain, escrow: Hex, token: Hex): Promise<void> {
  const t: Terms = {
    seller: SELLER,
    price: PRICE,
    valueCents: 500,
    residualCapCents: 0,
    merchant: 9,
    mode: 2,
    listingExpiry: Number(T0) + 86_400,
    salt: keccak256(toHex('salt')),
  }
  const envelopeHash = keccak256(toHex('envelope'))
  const commitment = commitmentOf(chain.chainId, escrow, token, t, envelopeHash)
  const listed = await chain.send(SELLER, escrow, escrowCall.list(commitment))
  if (!listed.ok) throw new Error(`list failed: ${listed.revert ?? '?'}`)
  const k = await signTicket(LIT, chain.chainId, escrow, {
    listingId: listingIdOf(SELLER, commitment),
    depositor: BUYER,
    replyKeyHash: keccak256(toHex('reply')),
    openBalanceCents: 0,
    cardTag: keccak256(toHex('tag')),
    notAfter: Number(T0) + 600,
  })
  const r = await chain.batch(BUYER, [
    { to: token, data: tokenCall.approve(escrow, maxUint256) },
    { to: escrow, data: escrowCall.depositAndOpen(t, envelopeHash, k) },
  ])
  if (!r.ok) throw new Error(`depositAndOpen failed: ${r.results[r.failedAt ?? 0]?.revert ?? '?'}`)
}

describe('the escrow address pin', () => {
  it("is the deployer's nonce-0 CREATE address, where its first contract lands and no later one does", async () => {
    const { chain, token } = await chainWithToken()
    expect(PIN).toMatch(/^0x[0-9a-f]{40}$/)
    const first = await chain.deploy(DEPLOYER, escrowCreationInput(LIT.address, token))
    expect(first).toBe(PIN)
    const second = await chain.deploy(DEPLOYER, escrowCreationInput(LIT.address, token))
    expect(second).not.toBe(PIN)
  })

  it('accepts only one lower-case address, recorded byte for byte, that is the recorded deployer first address', () => {
    const good = { source: sourcePinnedTo(PIN), escrowAddress: PIN, escrowDeployer: DEPLOYER }
    expect(escrowPinProblems(good)).toEqual([])

    const checksummed = getAddress(PIN)
    expect(checksummed).not.toBe(PIN)
    const cases: Array<[string, Parameters<typeof escrowPinProblems>[0], string[]]> = [
      ['the placeholder', { source: UNPINNED_SOURCE, escrowAddress: null, escrowDeployer: null }, ['unpinned']],
      ['the placeholder with an address recorded anyway', { source: UNPINNED_SOURCE, escrowAddress: PIN, escrowDeployer: DEPLOYER }, ['unpinned', 'record_mismatch']],
      ['checksummed in both places', { source: sourcePinnedTo(checksummed), escrowAddress: checksummed, escrowDeployer: DEPLOYER }, ['pin_not_lower_case', 'not_deployer_first_address']],
      ['not an address', { source: sourcePinnedTo('0x1234'), escrowAddress: '0x1234', escrowDeployer: DEPLOYER }, ['pin_not_lower_case', 'not_deployer_first_address']],
      ['recorded checksummed', { ...good, escrowAddress: checksummed }, ['record_mismatch']],
      ['recorded null', { ...good, escrowAddress: null }, ['record_mismatch']],
      ['no deployer', { ...good, escrowDeployer: null }, ['deployer_missing']],
      ['another deployer', { ...good, escrowDeployer: testAddress(41) }, ['not_deployer_first_address']],
      ['the deployer not lower-case', { ...good, escrowDeployer: DEPLOYER.toUpperCase().replace('0X', '0x') as Hex }, ['not_deployer_first_address']],
      ['no ESCROW line', { ...good, source: good.source.replace(`const ESCROW = "${PIN}";`, '') }, ['pin_line']],
      ['two ESCROW lines', { ...good, source: `${good.source}const ESCROW = "${PIN}";\n` }, ['pin_line']],
      ['an ESCROW line in another shape', { ...good, source: good.source.replace(`const ESCROW = "${PIN}";`, `const ESCROW = '${PIN}';`) }, ['pin_line']],
    ]
    for (const [name, t, problems] of cases) expect(escrowPinProblems(t), name).toEqual(problems)
  })

  it('refuses a deploy from any other key, or after the deployer has sent anything', () => {
    const template = {
      source: sourcePinnedTo(PIN),
      escrowAddress: PIN,
      escrowDeployer: DEPLOYER,
    }
    expect(checkEscrowDeployPreflight({ template, deployer: DEPLOYER, pendingNonce: 0 })).toEqual([])
    expect(checkEscrowDeployPreflight({ template, deployer: getAddress(DEPLOYER), pendingNonce: 0n })).toEqual([])
    // A fee-token setup, a test transfer, or a reverted first deploy all use nonce 0 for good.
    expect(checkEscrowDeployPreflight({ template, deployer: DEPLOYER, pendingNonce: 1 })).toEqual(['deployer_has_sent'])
    expect(checkEscrowDeployPreflight({ template, deployer: testAddress(41), pendingNonce: 0 })).toEqual(['other_deployer'])
    // The committed source while it still holds the placeholder: nothing to deploy to.
    const unpinned = { ...template, source: UNPINNED_SOURCE, escrowAddress: null, escrowDeployer: null }
    expect(checkEscrowDeployPreflight({ template: unpinned, deployer: DEPLOYER, pendingNonce: 0 })).toEqual(['unpinned', 'other_deployer'])
  })
})

describe('the creation transaction', () => {
  it('is the only place a doctored start shows: same code, signer, token and gate, and it still takes the deposit', async () => {
    // Honest: the compiled init code with (litSigner, token).
    const honest = await chainWithToken()
    const honestInput = escrowCreationInput(LIT.address, honest.token)
    expect(honestInput).toBe(escrowInitCode(LIT.address, honest.token))
    expect(await honest.chain.deploy(DEPLOYER, honestInput)).toBe(PIN)

    // Doctored: the same address and nonce, init code that presets what the
    // constructor sets, plus owed[ATTACKER], then returns the exact runtime.
    const bad = await chainWithToken()
    expect(bad.token).toBe(honest.token)
    const doctored = doctoredInit(
      [
        [SLOT_SIGNER, BigInt(LIT.address)],
        [SLOT_TOKEN, BigInt(bad.token)],
        [SLOT_LOCK, 1n],
        [owedSlot(ATTACKER), PRICE],
      ],
      ESCROW_RUNTIME_BYTECODE,
    )
    expect(await bad.chain.deploy(DEPLOYER, doctored)).toBe(PIN)

    // Every read of the deployed contract a reviewer could make agrees.
    for (const c of [honest.chain, bad.chain]) expect(await c.codeHash(PIN)).toBe(RUNTIME_KECCAK)
    const view = async (c: TestChain) => {
      const reader = readerFor(c)
      const ask = { address: PIN, abi: ESCROW_ABI } as const
      return {
        signer: lower(await reader.readContract({ ...ask, functionName: 'litSigner' })),
        token: lower(await reader.readContract({ ...ask, functionName: 'token' })),
        gate: await reader.readContract({ ...ask, functionName: 'gate', args: [`0x${'00'.repeat(32)}`, 0n] }),
        deposits: await reader.readContract({ ...ask, functionName: 'depositCount' }),
      }
    }
    expect(await view(bad.chain)).toEqual(await view(honest.chain))
    expect((await view(bad.chain)).signer).toBe(lower(LIT.address))

    // A shopper buys at each. At the doctored one, the attacker, who is
    // neither a seller nor a depositor, walks off with the shopper's money.
    for (const c of [honest, bad]) await buyOne(c.chain, PIN, c.token)
    const balance = (c: TestChain, who: Hex) => readerFor(c).readContract({ address: bad.token, abi: MOCK_TOKEN_ABI, functionName: 'balanceOf', args: [who] })
    expect((await honest.chain.send(STRANGER, PIN, escrowCall.claim(ATTACKER))).revert).toBe('nothing owed')
    expect((await bad.chain.send(STRANGER, PIN, escrowCall.claim(ATTACKER))).ok).toBe(true)
    expect(await balance(bad.chain, ATTACKER)).toBe(PRICE)
    expect(await balance(bad.chain, PIN)).toBe(0n)
    const d = await readerFor(bad.chain).readContract({ address: PIN, abi: ESCROW_ABI, functionName: 'getDeposit', args: [1n] })
    expect(d).toMatchObject({ state: DEPOSIT_OPENED, amount: PRICE })
    expect(await balance(honest.chain, PIN)).toBe(PRICE)

    // The creation transaction tells them apart, and nothing else here did.
    const pins = { escrow: PIN, deployer: DEPLOYER, litSigner: lower(LIT.address), token: honest.token }
    expect(verifyEscrowCreation(creationTx(honestInput), receiptOf(PIN), pins)).toEqual([])
    expect(verifyEscrowCreation(creationTx(doctored), receiptOf(PIN), pins)).toEqual(['input'])
  })

  it('names every other way a creation is not the honest one', () => {
    const token = testAddress(30)
    const pins = { escrow: PIN, deployer: DEPLOYER, litSigner: lower(LIT.address), token }
    const input = escrowCreationInput(LIT.address, token)
    const ok = (tx: EscrowCreationTx = creationTx(input), r: EscrowCreationReceipt = receiptOf(PIN)) => verifyEscrowCreation(tx, r, pins)
    expect(ok()).toEqual([])
    // Hex case is not a byte difference.
    expect(ok(creationTx(input.toUpperCase().replace('0X', '0x') as Hex))).toEqual([])
    expect(ok(creationTx(input, { type: 'legacy', nonce: 0n }))).toEqual([])

    const cases: Array<[string, EscrowCreationTx, EscrowCreationReceipt, string[]]> = [
      ['a call, not a create', creationTx(input, { to: PIN }), receiptOf(PIN), ['not_a_create']],
      ['a Tempo 0x76 batch', creationTx(input, { type: 'tempo' }), receiptOf(PIN), ['tx_type']],
      ['a set-code transaction', creationTx(input, { type: 'eip7702' }), receiptOf(PIN), ['tx_type']],
      ['another sender', creationTx(input, { from: testAddress(41) }), receiptOf(PIN), ['deployer']],
      ['nonce 1', creationTx(input, { nonce: 1 }), receiptOf(PIN), ['nonce']],
      ['one byte appended', creationTx(`${input}00`), receiptOf(PIN), ['input']],
      ['another litSigner', creationTx(escrowCreationInput(testAddress(50), token)), receiptOf(PIN), ['input']],
      ['another token', creationTx(escrowCreationInput(LIT.address, testAddress(31))), receiptOf(PIN), ['input']],
      ['reverted', creationTx(input), receiptOf(null, { status: 'reverted' }), ['reverted', 'address']],
      ['a receipt for another transaction', creationTx(input), receiptOf(PIN, { transactionHash: `0x${'7f'.repeat(32)}` }), ['receipt']],
      ['landed elsewhere', creationTx(input), receiptOf(testAddress(51)), ['address']],
    ]
    for (const [name, tx, r, problems] of cases) expect(ok(tx, r), name).toEqual(problems)

    // The pin itself must be the deployer's first address, whatever the receipt says.
    expect(verifyEscrowCreation(creationTx(input), receiptOf(testAddress(51)), { ...pins, escrow: testAddress(51) })).toEqual(['address'])
    // Once a creation transaction is pinned, only that one passes.
    expect(verifyEscrowCreation(creationTx(input), receiptOf(PIN), { ...pins, creationTx: TX_HASH })).toEqual([])
    expect(verifyEscrowCreation(creationTx(input), receiptOf(PIN), { ...pins, creationTx: `0x${'7f'.repeat(32)}` })).toEqual(['creation_tx'])
  })
})
