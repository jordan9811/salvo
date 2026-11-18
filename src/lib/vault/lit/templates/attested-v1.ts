/** FROZEN. See the header inside the string. Never edit; add attested-v2. */
export const ATTESTED_V1_SOURCE = String.raw`// salvo-vault-attested/1
//
// FROZEN RELEASE ARTIFACT. Lit derives this action's key from the IPFS CID of
// these exact bytes. Any edit, even whitespace, is a new CID and a new key, and
// every card sealed to the old bytes then opens only with the old bytes. Never
// edit this text: add salvo-vault-<verifier>/<n+1> beside it.
//
// CUSTODY: CUSTODIAL. The gate below trusts a signature from the attestor
// address named in each card's manifest. Salvo's server holds that key, so
// Salvo's server can open any card sealed here, alone.
//
// Trusted: this source. Untrusted: everything in params (Lit's js_params).
// The manifest arrives in params, but it is the AES-GCM additional data and is
// mixed into the key derivation, so a manifest we did not seal cannot decrypt.
const TEMPLATE_ID = "salvo-vault-attested/1";
const BIND_DOMAIN = "salvo/vault/bind/v1";
const OPEN_DOMAIN = "salvo/vault/open/v1";
const ENC_KEY_SALT = "salvo/vault/enc-key/v1";
const SEAL_INFO = "salvo/vault/seal/v1|";
const REPLY_INFO = "salvo/vault/reply/v1|";
const MAX_SKEW_MS = 120000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const PUB_RE = /^0x0[23][0-9a-f]{64}$/;
const SIG_RE = /^0x[0-9a-f]{130}$/;
const CID_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const B64_RE = /^[A-Za-z0-9+/]{1,1024}={0,2}$/;
const DENIED = { ok: false, error: "access_denied" };
const FAILED = { ok: false, error: "open_failed" };
const U = ethers.utils;

function canonical(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("number");
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const out = [];
    for (const k of Object.keys(v).sort()) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(k) || v[k] === undefined) throw new Error("key");
      out.push(JSON.stringify(k) + ":" + canonical(v[k]));
    }
    return "{" + out.join(",") + "}";
  }
  throw new Error("type");
}

function parseCanonical(text, maxLen, keyCount) {
  if (typeof text !== "string" || text.length === 0 || text.length > maxLen) return null;
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    if (Object.keys(value).length !== keyCount || canonical(value) !== text) return null;
    return value;
  } catch (e) {
    return null;
  }
}

function utf8(text) {
  return U.toUtf8Bytes(text);
}

function sha256Hex(text) {
  return U.sha256(utf8(text)).slice(2);
}

function bytes64(text, min, max) {
  if (typeof text !== "string" || !B64_RE.test(text)) return null;
  const b = U.base64.decode(text);
  return b.length >= min && b.length <= max ? b : null;
}

function hkdf32(ikm, salt, info) {
  // RFC 5869, SHA-256, L = 32: one expand block.
  const prk = U.computeHmac("sha256", salt, ikm);
  return U.arrayify(U.computeHmac("sha256", prk, U.concat([info, [1]])));
}

function encryptionKey(actionKey) {
  // Never use the identity key itself for ECDH: derive a separate key.
  const raw = hkdf32(U.arrayify(actionKey), utf8(ENC_KEY_SALT), utf8(TEMPLATE_ID));
  try {
    return new U.SigningKey(raw);
  } finally {
    raw.fill(0);
  }
}

function readManifest(text, now) {
  const m = parseCanonical(text, 2048, 7);
  if (!m) return null;
  if (m.v !== 1 || m.template !== TEMPLATE_ID || m.verifier !== "attested") return null;
  if (typeof m.intentId !== "string" || !ID_RE.test(m.intentId)) return null;
  if (m.orderId !== null && (typeof m.orderId !== "string" || !ID_RE.test(m.orderId))) return null;
  if (!Number.isSafeInteger(m.expiresAt) || now > m.expiresAt) return null;
  if (typeof m.attestor !== "string" || !ADDR_RE.test(m.attestor)) return null;
  return m;
}

function readEnvelope(e) {
  if (typeof e !== "object" || e === null || Object.keys(e).length !== 4) return null;
  if (typeof e.eph !== "string" || !PUB_RE.test(e.eph)) return null;
  try {
    U.computePublicKey(e.eph, false);
  } catch (err) {
    return null;
  }
  const iv = bytes64(e.iv, 12, 12);
  const ct = bytes64(e.ct, 1, 512);
  const tag = bytes64(e.tag, 16, 16);
  if (!iv || !ct || !tag) return null;
  const sha = sha256Hex(canonical({ ct: e.ct, eph: e.eph, iv: e.iv, tag: e.tag }));
  return { eph: e.eph, iv: iv, ct: ct, tag: tag, sha: sha };
}

function readAttestation(att, m, manifestText, envelopeSha, now) {
  if (typeof att !== "object" || att === null) return null;
  const a = parseCanonical(att.payload, 1024, 7);
  if (!a || a.domain !== OPEN_DOMAIN) return null;
  if (a.manifestSha256 !== sha256Hex(manifestText) || a.envelopeSha256 !== envelopeSha) return null;
  if (a.intentId !== m.intentId) return null;
  if (typeof a.orderId !== "string" || !ID_RE.test(a.orderId)) return null;
  if (m.orderId !== null && a.orderId !== m.orderId) return null;
  if (!Number.isSafeInteger(a.issuedAt) || Math.abs(now - a.issuedAt) > MAX_SKEW_MS) return null;
  if (typeof a.replyKey !== "string" || !PUB_RE.test(a.replyKey)) return null;
  if (typeof att.signature !== "string" || !SIG_RE.test(att.signature)) return null;
  try {
    U.computePublicKey(a.replyKey, false);
    if (U.verifyMessage(att.payload, att.signature).toLowerCase() !== m.attestor) return null;
  } catch (err) {
    return null;
  }
  return { replyKey: a.replyKey, payload: att.payload };
}

function validCard(card) {
  if (typeof card !== "object" || card === null || Array.isArray(card)) return false;
  if (typeof card.cardNumber !== "string" || card.cardNumber.length < 1 || card.cardNumber.length > 128) return false;
  return card.pin === null || (typeof card.pin === "string" && card.pin.length <= 64);
}

async function open(params) {
  const now = Date.now();
  const m = readManifest(params.manifest, now);
  if (!m) return DENIED;
  const env = readEnvelope(params.envelope);
  if (!env) return DENIED;
  const a = readAttestation(params.attestation, m, params.manifest, env.sha, now);
  if (!a) return DENIED;

  // Every independent check has passed. Only now is key material touched.
  let shared = null;
  let key = null;
  let plain = null;
  let rshared = null;
  let rkey = null;
  try {
    const enc = encryptionKey(await Lit.Actions.getLitActionPrivateKey());
    shared = U.arrayify(enc.computeSharedSecret(env.eph));
    key = hkdf32(shared, U.arrayify(env.eph), utf8(SEAL_INFO + sha256Hex(params.manifest)));
    const dk = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: env.iv, additionalData: utf8(params.manifest), tagLength: 128 },
      dk, U.concat([env.ct, env.tag])));
    if (!validCard(JSON.parse(U.toUtf8String(plain)))) return FAILED;

    // The card leaves only encrypted to the one-time reply key named in the
    // signed attestation, so Lit's response and logs never hold it in clear.
    const info = REPLY_INFO + sha256Hex(a.payload);
    rshared = U.arrayify(enc.computeSharedSecret(a.replyKey));
    rkey = hkdf32(rshared, U.arrayify(a.replyKey), utf8(info + "|key"));
    const riv = hkdf32(rshared, U.arrayify(a.replyKey), utf8(info + "|iv")).slice(0, 12);
    const ek = await crypto.subtle.importKey("raw", rkey, { name: "AES-GCM" }, false, ["encrypt"]);
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: riv, additionalData: utf8(info), tagLength: 128 }, ek, plain));
    return { ok: true, reply: U.base64.encode(sealed) };
  } catch (e) {
    return FAILED;
  } finally {
    if (shared) shared.fill(0);
    if (key) key.fill(0);
    if (plain) plain.fill(0);
    if (rshared) rshared.fill(0);
    if (rkey) rkey.fill(0);
  }
}

async function bind(params) {
  if (typeof params.cid !== "string" || !CID_RE.test(params.cid)) return DENIED;
  const actionKey = await Lit.Actions.getLitActionPrivateKey();
  const identity = new ethers.Wallet(actionKey);
  const named = await Lit.Actions.getLitActionWalletAddress({ ipfsId: params.cid });
  if (typeof named !== "string" || named.toLowerCase() !== identity.address.toLowerCase()) return DENIED;
  const binding = canonical({
    cid: params.cid,
    domain: BIND_DOMAIN,
    encPub: encryptionKey(actionKey).compressedPublicKey.toLowerCase(),
    template: TEMPLATE_ID,
  });
  return {
    ok: true,
    binding: binding,
    signature: await identity.signMessage(binding),
    identity: identity.address.toLowerCase(),
    now: Date.now(),
  };
}

async function main(params) {
  try {
    if (typeof params !== "object" || params === null) return DENIED;
    if (params.op === "open") return await open(params);
    if (params.op === "bind") return await bind(params);
    return DENIED;
  } catch (e) {
    return FAILED;
  }
}
`
