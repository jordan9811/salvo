/**
 * What the agent's client expects of the enclave (enclave-spec section 5).
 * NEVER IN THE IMAGE: allowing a new compose hash here would change the image,
 * which changes its compose hash, a loop with no end. The bundle test checks
 * this file is not an input of the enclave bundle.
 *
 * FILLED 2026-11-19 from deploy/enclave-inspect.json (runbook step 5), which
 * only a DCAP-valid, non-debug TDX quote can write. If `appId`,
 * `composeHashes`, `keyProvider` or `os` is ever null, the hardware check
 * refuses: it fails closed.
 *
 * `composeHashes` holds the current compose hash, and during an update also
 * the next one. Remove a superseded hash when the update finishes, so an older,
 * weaker version does not stay acceptable.
 */

import type { Hex } from 'viem'
import type { TcbStatus } from '@phala/dcap-qvl'

export interface EnclaveOsPin {
  mrtd: Hex
  rtmr0: Hex
  rtmr1: Hex
  rtmr2: Hex
}

export interface EnclaveIdentityPin {
  /** The app id from the replayed `app-id` event, 0x lower case. */
  appId: Hex | null
  /** Compose hashes this client accepts, 0x lower case. */
  composeHashes: readonly Hex[] | null
  /** The `key-provider` event's payload, as 0x lower-case hex of its bytes. */
  keyProvider: Hex | null
  /** The OS measurements the quote must carry. */
  os: EnclaveOsPin | null
  /**
   * Where `os` came from. `first-quote` is the inspect run's own values, with
   * no independent dstack verifier behind them (Q11): every answer then warns.
   */
  osSource: 'verifier' | 'first-quote'
  /** Intel TCB statuses accepted. Default UpToDate only (Q4). */
  tcbStatuses: readonly TcbStatus[]
}

export const ENCLAVE_IDENTITY_PIN: EnclaveIdentityPin = Object.freeze({
  appId: '0x57e1889572bf23e7198cd6814b62154981ef6036',
  // The hashes of the images the enclave may run. Measured on 2026-11-23: 0x94845f48…a6fc. The one before it stays
  // listed until the next image replaces it. Older hashes were removed as each new image was measured.
  composeHashes: Object.freeze([
    '0x9be94121f2e0296082fac3673c4dc132129ff02038f044ec3287db71739fda96',
    '0x94845f48deebb0c5789d581b7fa04eac2a71639548667802d1111a691e7ca6fc',
  ] as const),
  keyProvider: '0x7b226e616d65223a226b6d73222c226964223a223330353933303133303630373261383634386365336430323031303630383261383634386365336430333031303730333432303030346538653332356134373762306266323238303064633932376134366336383633383933386432383366653733643166393032386565616337303238313933663334373031323231393338373566353938623761646463353033653533343731326162343337623431323037373662626163333264646638383937663834346565227d',
  os: Object.freeze({
    mrtd: '0x2a674327c50218dba880066b349b8d559d749ed68dce33fd651c184a877d084b07a9e583767a7ad5da13ed91deec2b70',
    rtmr0: '0x68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96',
    rtmr1: '0x0d390cdff163d981adbe90bb1d3666463be9de93a83de9b09ad0fe233974fdddc475731ba40d0bdc523efe8887cf82b8',
    rtmr2: '0xdf939336955fec7a8d316b4ee4fe7b7e0810194c6911aa61c559882ad17984bfb4a7fc7c3112d25a4968f23bd6b907be',
  }),
  osSource: 'first-quote',
  tcbStatuses: Object.freeze(['UpToDate'] as const),
})

/**
 * The enclave's public address (the Phala gateway URL). Agents fetch the
 * identity and may send `start` here directly. Null until the runbook.
 */
export const ENCLAVE_RUNNER_ORIGIN: string | null = 'https://57e1889572bf23e7198cd6814b62154981ef6036-8080.dstack-pha1-prod5.phala.network'
