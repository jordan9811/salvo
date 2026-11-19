/**
 * pnpm escrow:compile builds SalvoEscrowV1, SalvoEscrowV2 and SalvoOrders with a
 * pinned compiler and writes the committed outputs.
 *
 *   pnpm escrow:compile            compile and write the outputs below.
 *   pnpm escrow:compile --check    compile and compare with the committed files.
 *                                  Writes nothing; exits 1 on any difference.
 *
 * Offline and free. solc-js carries its own compiler (soljson.js); nothing is
 * downloaded.
 *
 * Outputs:
 *   contracts/out/SalvoEscrowV1.json   the release artifact (ABI, bytecode,
 *                                      runtime code and its keccak, settings)
 *   src/lib/escrow/artifact.ts         the same, typed, for app code and tests
 *   contracts/out/SalvoEscrowV2.json   SalvoEscrowV2's release artifact
 *   src/lib/escrow/artifact-v2.ts      the same, typed. Its own export names
 *                                      (ESCROW_V2_ABI, RUNTIME_KECCAK_V2, ...), so
 *                                      code that reads both escrows needs no aliases.
 *   contracts/out/MockToken.json       the test token. Tests only.
 *   contracts/out/SalvoOrders.json     the order escrow's release artifact, with
 *                                      where its immutables sit in the runtime code
 *   src/lib/agent/orders/artifact.ts   the same, typed, plus the EIP-712 shapes the
 *                                      runner and agents sign against it
 *   contracts/out/MockUSDC.json        a USDC stand-in with EIP-3009. Tests only.
 *   contracts/out/MockSmartWallet.json a buyer with code (EIP-1271). Tests only.
 *
 * V1 is live and frozen: its outputs are written exactly as before V2 existed,
 * so adding V2 changed none of V1's committed bytes.
 *
 * WHY EVERYTHING IS PINNED. The escrow Lit template pins keccak256 of the
 * deployed runtime code (ESCROW_CODEHASH), and a deploy is accepted only when
 * the chain returns exactly that code. Anyone must be able to rebuild the same
 * bytes from this source, so every input that changes them is fixed here and
 * written into the artifact:
 *   - solc 0.8.37 exactly. The npm package version is the compiler version, and
 *     the loaded compiler is checked against it before compiling.
 *   - optimizer on, 200 runs; viaIR off. If solc reports "stack too deep",
 *     split the function. Never turn on viaIR: it changes the bytes.
 *   - evmVersion cancun. Tempo runs a newer EVM; this only keeps newer opcodes out.
 *   - no metadata hash and no CBOR tail, so the bytes do not depend on file
 *     paths, comments or the machine that compiled them.
 *
 * Sources must be LF only (.gitattributes pins contracts/** to LF). A CRLF
 * checkout is refused rather than compiled, so the recorded source sha256
 * means the same thing on every machine.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import solcModule from 'solc'
import { keccak256 } from 'viem'

export const SOLC_PIN = '0.8.37'

/** Every compiler setting that changes the bytes. Written into the artifact. */
export const SOLC_SETTINGS = Object.freeze({
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'cancun',
  viaIR: false,
  metadata: { bytecodeHash: 'none', appendCBOR: false },
})

export const ESCROW_SOURCE_PATH = 'contracts/SalvoEscrowV1.sol'
export const MOCK_TOKEN_SOURCE_PATH = 'contracts/test/MockToken.sol'
export const ESCROW_JSON_PATH = 'contracts/out/SalvoEscrowV1.json'
export const MOCK_TOKEN_JSON_PATH = 'contracts/out/MockToken.json'
export const ESCROW_TS_PATH = 'src/lib/escrow/artifact.ts'
export const ESCROW_V2_SOURCE_PATH = 'contracts/SalvoEscrowV2.sol'
export const ESCROW_V2_JSON_PATH = 'contracts/out/SalvoEscrowV2.json'
export const ESCROW_V2_TS_PATH = 'src/lib/escrow/artifact-v2.ts'
export const ORDERS_SOURCE_PATH = 'contracts/SalvoOrders.sol'
export const ORDERS_JSON_PATH = 'contracts/out/SalvoOrders.json'
export const ORDERS_TS_PATH = 'src/lib/agent/orders/artifact.ts'
export const MOCK_USDC_SOURCE_PATH = 'contracts/test/MockUSDC.sol'
export const MOCK_USDC_JSON_PATH = 'contracts/out/MockUSDC.json'
export const MOCK_WALLET_SOURCE_PATH = 'contracts/test/MockSmartWallet.sol'
export const MOCK_WALLET_JSON_PATH = 'contracts/out/MockSmartWallet.json'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** solc-js ships `any` types. This is the slice of it we use. */
interface SolcJs {
  version(): string
  compile(input: string): string
}
const solc: SolcJs = solcModule

type Hex = `0x${string}`

interface SolcError {
  severity: 'error' | 'warning' | 'info'
  formattedMessage?: string
  message: string
}

/** Where solc left room in the runtime code for one immutable: byte offset and length. */
interface CodeRange {
  start: number
  length: number
}

interface SolcOutput {
  errors?: SolcError[]
  sources?: Record<string, { id: number; ast?: unknown }>
  contracts?: Record<
    string,
    Record<
      string,
      {
        abi: unknown[]
        evm: {
          bytecode: { object: string }
          deployedBytecode: { object: string; immutableReferences?: Record<string, CodeRange[]> }
        }
      }
    >
  >
}

export interface CompiledContract {
  contractName: string
  source: string
  sourceSha256: string
  compiler: { name: 'solc-js'; version: string; settings: typeof SOLC_SETTINGS }
  abi: unknown[]
  bytecode: Hex
  deployedBytecode: Hex
  runtimeKeccak: Hex
  /** Compiler warnings, as text. The escrow is expected to have none. */
  warnings: string[]
  /**
   * Immutable name -> where its value sits in the runtime code. Empty for a
   * contract with none. In the compiled runtime those bytes are zero; the
   * constructor writes them at deploy.
   */
  immutables: Record<string, CodeRange[]>
}

/** The loaded compiler's full version, refused unless it is the pinned release. */
export function solcVersion(): string {
  const v = solc.version()
  if (!v.startsWith(`${SOLC_PIN}+`)) {
    throw new Error(`escrow:compile needs solc ${SOLC_PIN}; loaded ${v}. Run pnpm install.`)
  }
  return v
}

function readSource(root: string, path: string): string {
  const text = readFileSync(resolve(root, path), 'utf8')
  if (text.includes('\r')) {
    throw new Error(`${path} has CR line endings. Check .gitattributes (contracts/** text eol=lf) and re-checkout.`)
  }
  return text
}

/** Every `immutable` state variable's AST id and name, read from solc's AST. */
function immutableNames(ast: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const n = node as Record<string, unknown>
    if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable' && typeof n.name === 'string') {
      out.set(String(n.id), n.name)
    }
    for (const v of Object.values(n)) visit(v)
  }
  visit(ast)
  return out
}

function asHex(object: string, what: string): Hex {
  if (!/^([0-9a-f]{2})+$/.test(object)) throw new Error(`solc returned no ${what}`)
  return `0x${object}`
}

/**
 * Compile one source file on its own. Each contract is compiled alone so the
 * escrow's bytes can never depend on the test token sitting next to it.
 */
export function compileContract(sourcePath: string, contractName: string, root: string = REPO_ROOT): CompiledContract {
  const version = solcVersion()
  const content = readSource(root, sourcePath)
  const input = {
    language: 'Solidity',
    sources: { [sourcePath]: { content } },
    settings: {
      ...SOLC_SETTINGS,
      // Asking for more output never changes the bytes; the immutables' places come from these two.
      outputSelection: {
        '*': {
          '': ['ast'],
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'],
        },
      },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput
  const problems = output.errors ?? []
  const errors = problems.filter((e) => e.severity === 'error')
  if (errors.length > 0) {
    throw new Error(`solc refused ${sourcePath}:\n${errors.map((e) => e.formattedMessage ?? e.message).join('\n')}`)
  }
  const compiled = output.contracts?.[sourcePath]?.[contractName]
  if (!compiled) throw new Error(`solc produced no ${contractName} from ${sourcePath}`)
  const deployedBytecode = asHex(compiled.evm.deployedBytecode.object, 'runtime code')
  const names = immutableNames(output.sources?.[sourcePath]?.ast)
  const immutables: Record<string, CodeRange[]> = {}
  for (const [id, ranges] of Object.entries(compiled.evm.deployedBytecode.immutableReferences ?? {})) {
    const name = names.get(id)
    if (name === undefined) throw new Error(`solc named an immutable (AST id ${id}) that ${sourcePath} does not declare`)
    immutables[name] = ranges.map((r) => ({ start: r.start, length: r.length }))
  }
  return {
    contractName,
    source: sourcePath,
    sourceSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    compiler: { name: 'solc-js', version, settings: SOLC_SETTINGS },
    abi: compiled.abi,
    bytecode: asHex(compiled.evm.bytecode.object, 'creation code'),
    deployedBytecode,
    runtimeKeccak: keccak256(deployedBytecode),
    warnings: problems.filter((e) => e.severity === 'warning').map((e) => e.formattedMessage ?? e.message),
    immutables,
  }
}

function artifactJson(c: CompiledContract, version: string | null): string {
  const out = {
    contractName: c.contractName,
    ...(version === null ? {} : { version }),
    source: c.source,
    sourceSha256: c.sourceSha256,
    compiler: c.compiler,
    runtimeKeccak: c.runtimeKeccak,
    abi: c.abi,
    bytecode: c.bytecode,
    deployedBytecode: c.deployedBytecode,
  }
  return JSON.stringify(out, null, 2) + '\n'
}

function artifactTs(c: CompiledContract): string {
  return [
    '/**',
    ' * GENERATED by `pnpm escrow:compile` from contracts/SalvoEscrowV1.sol. Do not edit:',
    ' * change the contract, rerun the compile, and commit both. tests/escrow-contract.test.ts',
    ' * fails when this file and a fresh compile disagree.',
    ' *',
    ' * RUNTIME_KECCAK is what the escrow Lit template pins as ESCROW_CODEHASH, and what a',
    ' * deploy must read back from the chain. Frozen once released, like the contract.',
    ' */',
    '',
    "export const ESCROW_CONTRACT_VERSION = 'salvo-escrow/1'",
    `export const SOLC_VERSION = '${c.compiler.version}'`,
    `export const SOLC_SETTINGS = ${JSON.stringify(c.compiler.settings)} as const`,
    `export const ESCROW_SOURCE_SHA256 = '${c.sourceSha256}'`,
    `export const RUNTIME_KECCAK: \`0x\${string}\` = '${c.runtimeKeccak}'`,
    `export const ESCROW_ABI = ${JSON.stringify(c.abi, null, 2)} as const`,
    `export const ESCROW_BYTECODE: \`0x\${string}\` = '${c.bytecode}'`,
    `export const ESCROW_RUNTIME_BYTECODE: \`0x\${string}\` = '${c.deployedBytecode}'`,
    '',
  ].join('\n')
}

/** SalvoEscrowV2's typed module. Same shape as V1's, under V2 names. */
function artifactTsV2(c: CompiledContract): string {
  return [
    '/**',
    ' * GENERATED by `pnpm escrow:compile` from contracts/SalvoEscrowV2.sol. Do not edit:',
    ' * change the contract, rerun the compile, and commit both. tests/escrow-v2-contract.test.ts',
    ' * fails when this file and a fresh compile disagree.',
    ' *',
    ' * RUNTIME_KECCAK_V2 is what salvo-vault-escrow/2 pins as ESCROW_CODEHASH, and what a',
    ' * deploy must read back from the chain. Frozen once released, like the contract.',
    ' */',
    '',
    "export const ESCROW_V2_CONTRACT_VERSION = 'salvo-escrow/2'",
    `export const ESCROW_V2_SOLC_VERSION = '${c.compiler.version}'`,
    `export const ESCROW_V2_SOLC_SETTINGS = ${JSON.stringify(c.compiler.settings)} as const`,
    `export const ESCROW_V2_SOURCE_SHA256 = '${c.sourceSha256}'`,
    `export const RUNTIME_KECCAK_V2: \`0x\${string}\` = '${c.runtimeKeccak}'`,
    `export const ESCROW_V2_ABI = ${JSON.stringify(c.abi, null, 2)} as const`,
    `export const ESCROW_V2_BYTECODE: \`0x\${string}\` = '${c.bytecode}'`,
    `export const ESCROW_V2_RUNTIME_BYTECODE: \`0x\${string}\` = '${c.deployedBytecode}'`,
    '',
  ].join('\n')
}

/** Byte offsets per immutable, keys sorted, so the committed text never depends on solc's order. */
function sortedImmutables(c: CompiledContract): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const name of Object.keys(c.immutables).sort()) {
    const ranges = c.immutables[name] ?? []
    // Every immutable here is an address, one 32-byte word per use. Anything else is a contract
    // change the runtime-code rebuild in artifact.ts was not written for.
    if (ranges.some((r) => r.length !== 32)) throw new Error(`${c.contractName}.${name}: an immutable that is not one word`)
    out[name] = ranges.map((r) => r.start).sort((a, b) => a - b)
  }
  return out
}

/** SalvoOrders' release artifact: V2's fields plus where the immutables sit. */
function ordersArtifactJson(c: CompiledContract): string {
  const out = {
    contractName: c.contractName,
    version: 'salvo-orders/1',
    source: c.source,
    sourceSha256: c.sourceSha256,
    compiler: c.compiler,
    runtimeTemplateKeccak: c.runtimeKeccak,
    immutableOffsets: sortedImmutables(c),
    abi: c.abi,
    bytecode: c.bytecode,
    deployedBytecode: c.deployedBytecode,
  }
  return JSON.stringify(out, null, 2) + '\n'
}

/**
 * SalvoOrders' typed module. The constants are generated; the code after them is fixed text
 * (ORDERS_TS_TAIL), kept here so the whole file is one generated unit the drift check covers.
 */
function artifactTsOrders(c: CompiledContract): string {
  const immutables = sortedImmutables(c)
  const names = Object.keys(immutables).join(',')
  if (names !== 'payout,runner,token') {
    throw new Error(`SalvoOrders immutables are ${names}; artifact.ts rebuilds exactly payout, runner and token`)
  }
  return [
    '/**',
    ' * GENERATED by `pnpm escrow:compile` from contracts/SalvoOrders.sol (the code after',
    ' * the constants is fixed text in scripts/escrow-compile.ts). Do not edit: change the',
    ' * contract or the script, rerun the compile, and commit both.',
    ' * tests/salvo-orders-contract.test.ts fails when this file and a fresh compile',
    ' * disagree, and signs with the EIP-712 shapes below against the contract itself.',
    ' *',
    ' * token, runner and payout are immutables, so they are written into the deployed',
    ' * runtime code and its hash differs per deployment. ORDERS_RUNTIME_TEMPLATE is that',
    ' * code with their words zeroed; ordersRuntimeKeccak fills them in, and is what a',
    ' * pin compares with the chain.',
    ' */',
    '',
    "import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'",
    '',
    "export const ORDERS_CONTRACT_VERSION = 'salvo-orders/1'",
    `export const ORDERS_SOLC_VERSION = '${c.compiler.version}'`,
    `export const ORDERS_SOLC_SETTINGS = ${JSON.stringify(c.compiler.settings)} as const`,
    `export const ORDERS_SOURCE_SHA256 = '${c.sourceSha256}'`,
    '/** keccak256 of ORDERS_RUNTIME_TEMPLATE: the runtime code with every immutable zeroed. */',
    `export const ORDERS_RUNTIME_TEMPLATE_KECCAK: Hex = '${c.runtimeKeccak}'`,
    "/** Byte offsets of each immutable's 32-byte word in the runtime code. */",
    `export const ORDERS_IMMUTABLE_OFFSETS = ${JSON.stringify(immutables)} as const`,
    `export const ORDERS_ABI = ${JSON.stringify(c.abi, null, 2)} as const`,
    `export const ORDERS_BYTECODE: Hex = '${c.bytecode}'`,
    `export const ORDERS_RUNTIME_TEMPLATE: Hex = '${c.deployedBytecode}'`,
    ORDERS_TS_TAIL,
  ].join('\n')
}

/**
 * The hand-written half of src/lib/agent/orders/artifact.ts: the runtime-code rebuild and the
 * typed data the runner and a Base buyer sign. Written without backticks, so it fits String.raw.
 */
const ORDERS_TS_TAIL = String.raw`
/** The constructor's arguments, which are also the immutables. */
export interface OrdersDeployArgs {
  token: Address
  runner: Address
  payout: Address
}

const ZERO_WORD = '0'.repeat(64)

/**
 * The runtime code a SalvoOrders deployed with these arguments has. Each immutable is
 * one address, left-padded to a word, at every offset solc recorded for it.
 *
 * @wiring-exempt: the order pins and scripts/orders-check.ts (spec section 3) call it; this step builds the contract alone
 */
export function ordersRuntimeCode(args: OrdersDeployArgs): Hex {
  let hex = ORDERS_RUNTIME_TEMPLATE.slice(2)
  for (const name of ['token', 'runner', 'payout'] as const) {
    const value = args[name]
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('ordersRuntimeCode: ' + name + ' is not an address')
    const word = value.slice(2).toLowerCase().padStart(64, '0')
    for (const start of ORDERS_IMMUTABLE_OFFSETS[name]) {
      const at = start * 2
      // The template holds zeros there; anything else means the offsets and the code disagree.
      if (hex.slice(at, at + 64) !== ZERO_WORD) throw new Error('ordersRuntimeCode: ' + name + ' word at ' + start + ' is not empty')
      hex = hex.slice(0, at) + word + hex.slice(at + 64)
    }
  }
  return ('0x' + hex) as Hex
}

/**
 * keccak256 of the runtime code for these arguments: what the chain must return for the
 * deployed address, so one hash pins the code, the token, the runner and the payout together.
 *
 * @wiring-exempt: the order pins and scripts/orders-check.ts (spec section 3) call it; this step builds the contract alone
 */
export function ordersRuntimeKeccak(args: OrdersDeployArgs): Hex {
  return keccak256(ordersRuntimeCode(args))
}

// ------------------------------------------------------------------ what the runner signs
export const ORDERS_EIP712_NAME = 'SalvoOrders'
export const ORDERS_EIP712_VERSION = '1'

/**
 * The EIP-712 domain of one SalvoOrders deployment. A settle signature names the chain and
 * the contract, so it settles nothing anywhere else.
 *
 * @wiring-exempt: the runner signs and the agent client checks with it (spec sections 6 and 7); this step builds the contract alone
 */
export function ordersDomain(chainId: number | bigint, verifyingContract: Address) {
  return { name: ORDERS_EIP712_NAME, version: ORDERS_EIP712_VERSION, chainId: BigInt(chainId), verifyingContract } as const
}

/**
 * Settle(id, buyer, amount, deadline, termsHash, resultHash, refund), for viem signTypedData
 * with primaryType 'Settle'. buyer, amount, deadline and termsHash are the order's own, as
 * getOrder(id) returns them: the contract reads them from storage, so a signature made for
 * one order never settles another, even one that a reorg moved to the same id.
 */
export const SETTLE_TYPES = {
  Settle: [
    { name: 'id', type: 'uint256' },
    { name: 'buyer', type: 'address' },
    { name: 'amount', type: 'uint96' },
    { name: 'deadline', type: 'uint40' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'resultHash', type: 'bytes32' },
    { name: 'refund', type: 'uint96' },
  ],
} as const

// ------------------------------------------------------------------ what a Base buyer signs
/**
 * Circle's EIP-3009 ReceiveWithAuthorization, for viem signTypedData with primaryType
 * 'ReceiveWithAuthorization' and the token's own domain (Base Sepolia USDC: name 'USDC',
 * version '2'). 'to' is the SalvoOrders contract, and only the payee may redeem it, so a
 * signature seen in flight cannot be spent anywhere else.
 *
 * A buyer address with no code signs it with its key and either open form works. A buyer
 * address WITH code (a smart wallet, an EIP-7702 account) is checked by USDC through that
 * code's EIP-1271 isValidSignature, never by ECDSA: send its signature, whatever its length,
 * to openWithAuthorizationSignature, or have it use approve + open.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** One order's parameters, as SalvoOrders.authorizationNonce takes them, plus where it runs. */
export interface OrderNonceInput {
  chainId: number | bigint
  contract: Address
  buyer: Address
  termsHash: Hex
  amount: bigint
  deadline: number | bigint
}

/**
 * The nonce an order's authorization must carry: its parameters hashed with the chain and
 * the contract, exactly as SalvoOrders.authorizationNonce. A relayer who changes any of
 * them no longer matches the nonce the buyer signed.
 *
 * @wiring-exempt: the quote route and the agent client (spec sections 5 and 7) call it; this step builds the contract alone
 */
export function ordersAuthorizationNonce(o: OrderNonceInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint96' }, { type: 'uint40' }],
      [BigInt(o.chainId), o.contract, o.buyer, o.termsHash, o.amount, Number(o.deadline)],
    ),
  )
}
`

export interface CompileResult {
  escrow: CompiledContract
  escrowV2: CompiledContract
  mockToken: CompiledContract
  orders: CompiledContract
  mockUsdc: CompiledContract
  mockWallet: CompiledContract
  /** Repo-relative path to the exact text that should be committed there. */
  files: Map<string, string>
}

export function compileEscrow(root: string = REPO_ROOT): CompileResult {
  const escrow = compileContract(ESCROW_SOURCE_PATH, 'SalvoEscrowV1', root)
  const escrowV2 = compileContract(ESCROW_V2_SOURCE_PATH, 'SalvoEscrowV2', root)
  const mockToken = compileContract(MOCK_TOKEN_SOURCE_PATH, 'MockToken', root)
  const orders = compileContract(ORDERS_SOURCE_PATH, 'SalvoOrders', root)
  const mockUsdc = compileContract(MOCK_USDC_SOURCE_PATH, 'MockUSDC', root)
  const mockWallet = compileContract(MOCK_WALLET_SOURCE_PATH, 'MockSmartWallet', root)
  const files = new Map<string, string>([
    [ESCROW_JSON_PATH, artifactJson(escrow, 'salvo-escrow/1')],
    [ESCROW_TS_PATH, artifactTs(escrow)],
    [ESCROW_V2_JSON_PATH, artifactJson(escrowV2, 'salvo-escrow/2')],
    [ESCROW_V2_TS_PATH, artifactTsV2(escrowV2)],
    [MOCK_TOKEN_JSON_PATH, artifactJson(mockToken, null)],
    [ORDERS_JSON_PATH, ordersArtifactJson(orders)],
    [ORDERS_TS_PATH, artifactTsOrders(orders)],
    [MOCK_USDC_JSON_PATH, artifactJson(mockUsdc, null)],
    [MOCK_WALLET_JSON_PATH, artifactJson(mockWallet, null)],
  ])
  return { escrow, escrowV2, mockToken, orders, mockUsdc, mockWallet, files }
}

/** Committed files that differ from a fresh compile (missing counts as different). */
export function driftedFiles(result: CompileResult, root: string = REPO_ROOT): string[] {
  const out: string[] = []
  for (const [path, text] of result.files) {
    const full = resolve(root, path)
    if (!existsSync(full) || readFileSync(full, 'utf8') !== text) out.push(path)
  }
  return out
}

function main(): void {
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => a !== '--check' && a !== '--')
  if (unknown.length > 0) {
    console.error(`  escrow:compile: unknown argument(s): ${unknown.map((a) => (a.startsWith('--') ? a : '(positional)')).join(', ')}`)
    process.exit(2)
  }
  const check = args.includes('--check')
  const result = compileEscrow()
  for (const c of [result.escrow, result.escrowV2, result.mockToken, result.orders, result.mockUsdc, result.mockWallet]) {
    for (const w of c.warnings) console.warn(`  warning (${c.contractName}):\n${w}`)
  }

  console.log(`  solc            ${result.escrow.compiler.version}`)
  for (const c of [result.escrow, result.escrowV2]) {
    console.log(`  ${c.contractName}`)
    console.log(`    source sha256   ${c.sourceSha256}`)
    console.log(`    runtime bytes   ${(c.deployedBytecode.length - 2) / 2}`)
    console.log(`    RUNTIME_KECCAK  ${c.runtimeKeccak}`)
  }
  // Its immutables are in the runtime code, so a deployment's hash depends on the constructor's
  // arguments; this is the hash with them zeroed (ordersRuntimeKeccak gives a deployment's).
  console.log(`  ${result.orders.contractName}`)
  console.log(`    source sha256   ${result.orders.sourceSha256}`)
  console.log(`    runtime bytes   ${(result.orders.deployedBytecode.length - 2) / 2}`)
  console.log(`    template keccak ${result.orders.runtimeKeccak}`)

  if (check) {
    const drifted = driftedFiles(result)
    if (drifted.length > 0) {
      console.error(`  DRIFT: ${drifted.join(', ')} differ from a fresh compile. Run pnpm escrow:compile and review the diff.`)
      process.exit(1)
    }
    console.log('  check: committed outputs equal a fresh compile')
    return
  }
  for (const [path, text] of result.files) {
    const full = resolve(REPO_ROOT, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
    console.log(`  wrote           ${path}`)
  }
}

if (process.argv[1] && /escrow-compile\.ts$/.test(process.argv[1])) main()
