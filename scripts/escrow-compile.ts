/**
 * pnpm escrow:compile builds SalvoEscrowV1 and SalvoEscrowV2 with a pinned
 * compiler and writes the committed outputs.
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

interface SolcOutput {
  errors?: SolcError[]
  contracts?: Record<
    string,
    Record<string, { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>
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
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
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

export interface CompileResult {
  escrow: CompiledContract
  escrowV2: CompiledContract
  mockToken: CompiledContract
  /** Repo-relative path to the exact text that should be committed there. */
  files: Map<string, string>
}

export function compileEscrow(root: string = REPO_ROOT): CompileResult {
  const escrow = compileContract(ESCROW_SOURCE_PATH, 'SalvoEscrowV1', root)
  const escrowV2 = compileContract(ESCROW_V2_SOURCE_PATH, 'SalvoEscrowV2', root)
  const mockToken = compileContract(MOCK_TOKEN_SOURCE_PATH, 'MockToken', root)
  const files = new Map<string, string>([
    [ESCROW_JSON_PATH, artifactJson(escrow, 'salvo-escrow/1')],
    [ESCROW_TS_PATH, artifactTs(escrow)],
    [ESCROW_V2_JSON_PATH, artifactJson(escrowV2, 'salvo-escrow/2')],
    [ESCROW_V2_TS_PATH, artifactTsV2(escrowV2)],
    [MOCK_TOKEN_JSON_PATH, artifactJson(mockToken, null)],
  ])
  return { escrow, escrowV2, mockToken, files }
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
  for (const c of [result.escrow, result.escrowV2, result.mockToken]) {
    for (const w of c.warnings) console.warn(`  warning (${c.contractName}):\n${w}`)
  }

  console.log(`  solc            ${result.escrow.compiler.version}`)
  for (const c of [result.escrow, result.escrowV2]) {
    console.log(`  ${c.contractName}`)
    console.log(`    source sha256   ${c.sourceSha256}`)
    console.log(`    runtime bytes   ${(c.deployedBytecode.length - 2) / 2}`)
    console.log(`    RUNTIME_KECCAK  ${c.runtimeKeccak}`)
  }

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
