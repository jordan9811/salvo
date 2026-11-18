/** FROZEN. See the header inside the string. Never edit; add escrow-v2. */
export const ESCROW_V1_SOURCE = String.raw`// salvo-vault-escrow/1
//
// FROZEN RELEASE ARTIFACT. Lit derives this action's key from the IPFS CID of
// these exact bytes. Any edit, even whitespace, is a new CID, a new key and a
// new escrow signer. Never edit this text: add salvo-vault-escrow/2 beside it.
//
// CUSTODY: a card leaves this action only encrypted to the reply key recorded
// in an on-chain purchase (SalvoEscrowV1.depositAndOpen) that has already moved
// the listing price into escrow, payable only to the card's own seller. That
// fact is read at one finalized block from two pinned RPC hosts that must agree
// byte for byte, from the one escrow pinned below by address and code hash.
// Nothing Salvo's server signs or says is trusted. Lit is.
//
// TESTNET ONLY: Tempo Moderato (chain 42431) and pathUSD are fixed below.
const TEMPLATE_ID = "salvo-vault-escrow/1";
const CHAIN_ID = 42431;
const CHAIN_ID_HEX = "0xa5bf";
const RPCS = ["https://rpc.moderato.tempo.xyz", "https://tempo-moderato-testnet.drpc.org"];
const TOKEN = "0x20c0000000000000000000000000000000000000";
// The escrow, by address. A code hash covers code, never storage: the same code
// deployed by other init code could start with any litSigner, owed balances or
// sales it likes. So only this one deployment is trusted. It is the deployer's
// first CREATE address, which is fixed before this file's CID exists. The
// address alone does not prove clean storage either, because the deployer
// picks the init code that runs there. It is trusted only together with its
// creation transaction, checked off chain before any listing: a plain create
// whose input is the compiled bytecode and (litSigner, pathUSD), byte for byte.
const ESCROW = "0x75c9aabe8254559f865e14d6e5fa70c738869bef";
const ESCROW_CODEHASH = "0x6a13510f164201a1540ecb7deaa4a4cbf02135b67b89e69d074dc065a77a2824";
const MAX_HEAD_SPREAD = 30;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY = 262144;
const TTL_READABLE_S = 300;
const TTL_BLIND_S = 600;
const UNITS_PER_CENT = 10000;
const MAX_VALUE_CENTS = 50000;
const MAX_EXPIRY = 1099511627775;
const BIND_DOMAIN = "salvo/vault/bind/v1";
const ENC_KEY_SALT = "salvo/vault/enc-key/v1";
const SEAL_INFO = "salvo/vault/seal/v1|";
const REPLY_INFO = "salvo/vault/reply/v1|";
const REPLY_DOMAIN = "salvo/escrow/reply/v1";
const TAG_SALT = "salvo/escrow/card-tag/v1";
const L_ACTIVE = 1;
const D_OPENED = 1;
const D_RELEASED = 2;
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const HEX32_RE = /^0x[0-9a-f]{64}$/;
const SALT_RE = /^[0-9a-f]{64}$/;
const NUM_RE = /^0x[0-9a-f]{1,16}$/;
const HEX_RE = /^0x([0-9a-f]{2})+$/;
const PUB_RE = /^0x0[23][0-9a-f]{64}$/;
const CID_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const B64_RE = /^[A-Za-z0-9+/]{1,1024}={0,2}$/;
const ID_RE = /^[1-9][0-9]{0,14}$/;
const MONEY_RE = /^[0-9]{1,7}([.][0-9]{1,2})?$/;
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DENIED = { ok: false, error: "access_denied" };
const FAILED = { ok: false, error: "open_failed" };
const U = ethers.utils;
const TERMS_TYPEHASH = U.id("SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)");
const LISTING_TYPEHASH = U.id("SalvoListing(bytes32 coreHash,bytes32 envelopeHash)");
const OPEN_TYPEHASH = U.id("Open(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint40 notAfter)");
const DOMAIN_TYPEHASH = U.id("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
const GATE_SELECTOR = U.id("gate(bytes32,uint256)").slice(0, 10);
const GATE_TYPES = ["address", "address", "address", "uint8", "uint8", "bytes32", "bytes32", "address"];

// Merchant table. Mode 1: this action reads the balance before opening. Mode 2: blind.
// A merchant allowing both lets a seller list "unchecked" if the reader is blocked.
const MERCHANTS = {
  "1": { name: "bestbuy", modes: [1, 2], cap: 1000, card: /^[0-9]{12,19}$/, pin: /^[0-9]{3,8}$/, reader: "bestbuy" },
  "2": { name: "nike", modes: [1, 2], cap: 1000, card: /^[0-9]{12,19}$/, pin: /^[0-9]{3,8}$/, reader: "nike" },
  "3": { name: "target", modes: [2], cap: 500, card: /^[0-9]{26}$/, pin: null, reader: null },
  "4": { name: "walmart", modes: [2], cap: 500, card: /^[0-9]{16}$/, pin: /^[0-9]{4}$/, reader: null },
  "9": { name: "salvotest", modes: [2], cap: 500, card: /^9999[0-9]{12}$/, pin: null, reader: null }
};

// canonical, parseCanonical, utf8, sha256Hex, bytes64, hkdf32, encryptionKey,
// readEnvelope, validCard: byte for byte from salvo-vault-attested/1.

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

function validCard(card) {
  if (typeof card !== "object" || card === null || Array.isArray(card)) return false;
  if (typeof card.cardNumber !== "string" || card.cardNumber.length < 1 || card.cardNumber.length > 128) return false;
  return card.pin === null || (typeof card.pin === "string" && card.pin.length <= 64);
}

function num(x) { return typeof x === "number" ? x : x.toNumber(); }

function parseJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }

function pinOk(mc, pin) {
  if (pin === null) return true;
  return mc.pin !== null && mc.pin.test(pin);
}

function readManifest(text) {
  const m = parseCanonical(text, 2048, 13);
  if (!m) return null;
  if (m.v !== 1 || m.template !== TEMPLATE_ID || m.chainId !== CHAIN_ID || m.token !== TOKEN) return null;
  if (m.escrow !== ESCROW) return null;
  if (typeof m.seller !== "string" || !ADDR_RE.test(m.seller)) return null;
  if (!Number.isSafeInteger(m.merchant) || !Object.prototype.hasOwnProperty.call(MERCHANTS, String(m.merchant))) return null;
  const mc = MERCHANTS[String(m.merchant)];
  if (mc.modes.indexOf(m.mode) < 0) return null;
  if (!Number.isSafeInteger(m.valueCents) || m.valueCents < 1 || m.valueCents > MAX_VALUE_CENTS) return null;
  if (!Number.isSafeInteger(m.price) || m.price < 1 || m.price > m.valueCents * UNITS_PER_CENT) return null;
  if (!Number.isSafeInteger(m.residualCapCents) || m.residualCapCents < 0 || m.residualCapCents > mc.cap) return null;
  if (!Number.isSafeInteger(m.listingExpiry) || m.listingExpiry < 1 || m.listingExpiry > MAX_EXPIRY) return null;
  if (typeof m.salt !== "string" || !SALT_RE.test(m.salt)) return null;
  return { m: m, mc: mc };
}

function listingIdOf(m, envelopeSha) {
  const A = U.defaultAbiCoder;
  const core = U.keccak256(A.encode(
    ["bytes32", "uint256", "address", "address", "address", "uint96", "uint32", "uint16", "uint8", "uint8", "uint40", "bytes32"],
    [TERMS_TYPEHASH, CHAIN_ID, m.escrow, TOKEN, m.seller, m.price, m.valueCents, m.residualCapCents, m.merchant, m.mode, m.listingExpiry, "0x" + m.salt]));
  const commitment = U.keccak256(A.encode(["bytes32", "bytes32", "bytes32"], [LISTING_TYPEHASH, core, "0x" + envelopeSha]));
  return U.keccak256(A.encode(["address", "bytes32"], [m.seller, commitment])).toLowerCase();
}

async function timedFetch(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body,
      redirect: "error", credentials: "omit", signal: ctl.signal });
    const text = await res.text();
    if (text.length > MAX_BODY) return null;
    return { status: res.status, text: text };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// At most 3 calls per batch: the dRPC free plan refuses larger batches.
async function rpcBatch(url, calls) {
  const body = JSON.stringify(calls.map(function (c, i) { return { jsonrpc: "2.0", id: i + 1, method: c[0], params: c[1] }; }));
  const res = await timedFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body });
  if (!res || res.status !== 200) return null;
  const arr = parseJson(res.text);
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (let i = 0; i < calls.length; i++) {
    const r = arr.find(function (x) { return x !== null && typeof x === "object" && x.id === i + 1; });
    if (!r || r.error !== undefined || r.result === undefined || r.result === null) return null;
    out.push(r.result);
  }
  return out;
}

// Round 1 per host: chain id and finalized head. Round 2 per host, at the lower
// head N: block N, the escrow's code, and gate(). Four fetches. Every host must
// answer and agree byte for byte, or this returns null (the caller denies). It
// never throws: a malformed answer is a refusal like any other.
async function readGate(escrow, listingId, depositId) {
  const heads = await Promise.all(RPCS.map(function (u) {
    return rpcBatch(u, [["eth_chainId", []], ["eth_getBlockByNumber", ["finalized", false]]]);
  }));
  let lo = 0;
  let hi = 0;
  for (const h of heads) {
    if (!h || h[0] !== CHAIN_ID_HEX || typeof h[1] !== "object" || typeof h[1].number !== "string" || !NUM_RE.test(h[1].number)) return null;
    const k = parseInt(h[1].number, 16);
    if (!Number.isSafeInteger(k) || k < 1) return null;
    lo = lo === 0 ? k : Math.min(lo, k);
    hi = Math.max(hi, k);
  }
  if (hi - lo > MAX_HEAD_SPREAD) return null;
  const tag = "0x" + lo.toString(16);
  const data = GATE_SELECTOR + U.defaultAbiCoder.encode(["bytes32", "uint256"], [listingId, depositId]).slice(2);
  const reads = await Promise.all(RPCS.map(function (u) {
    return rpcBatch(u, [["eth_getBlockByNumber", [tag, false]], ["eth_getCode", [escrow, tag]], ["eth_call", [{ to: escrow, data: data }, tag]]]);
  }));
  let seen = null;
  for (const r of reads) {
    if (!r || typeof r[0] !== "object" || typeof r[0].hash !== "string" || typeof r[0].timestamp !== "string") return null;
    if (String(r[0].number).toLowerCase() !== tag || !NUM_RE.test(r[0].timestamp)) return null;
    if (typeof r[1] !== "string" || !HEX_RE.test(r[1]) || U.keccak256(r[1]).toLowerCase() !== ESCROW_CODEHASH) return null;
    if (typeof r[2] !== "string" || !HEX_RE.test(r[2]) || r[2].length !== 2 + 64 * GATE_TYPES.length) return null;
    const s = (r[0].hash + "|" + r[0].timestamp + "|" + r[2]).toLowerCase();
    if (seen === null) seen = s; else if (seen !== s) return null;
  }
  const t = parseInt(reads[0][0].timestamp, 16);
  if (!Number.isSafeInteger(t) || t < 1) return null;
  // ethers defers a word it cannot decode to the moment it is read, so every
  // read is inside the try too.
  try {
    const d = U.defaultAbiCoder.decode(GATE_TYPES, reads[0][2]);
    return { time: t, signer: d[0].toLowerCase(), token: d[1].toLowerCase(), listingSeller: d[2].toLowerCase(),
      listingState: num(d[3]), depositState: num(d[4]), depositListingId: d[5].toLowerCase(),
      replyKeyHash: d[6].toLowerCase(), depositor: d[7].toLowerCase() };
  } catch (e) {
    return null;
  }
}

function openDigest(escrow, listingId, depositor, replyKeyHash, balance, tag, notAfter) {
  const A = U.defaultAbiCoder;
  const domain = U.keccak256(A.encode(["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [DOMAIN_TYPEHASH, U.id("SalvoEscrow"), U.id("1"), CHAIN_ID, escrow]));
  const struct = U.keccak256(A.encode(["bytes32", "bytes32", "address", "bytes32", "uint32", "bytes32", "uint40"],
    [OPEN_TYPEHASH, listingId, depositor, replyKeyHash, balance, tag, notAfter]));
  return U.keccak256(U.concat(["0x1901", domain, struct]));
}

async function openCard(actionKey, env, manifestText) {
  const enc = encryptionKey(actionKey);
  let shared = null;
  let key = null;
  let plain = null;
  try {
    shared = U.arrayify(enc.computeSharedSecret(env.eph));
    key = hkdf32(shared, U.arrayify(env.eph), utf8(SEAL_INFO + sha256Hex(manifestText)));
    const dk = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: env.iv, additionalData: utf8(manifestText), tagLength: 128 }, dk, U.concat([env.ct, env.tag])));
    const card = JSON.parse(U.toUtf8String(plain));
    if (!validCard(card)) { plain.fill(0); return null; }
    return { enc: enc, plain: plain, card: card };
  } catch (e) {
    if (plain) plain.fill(0);
    return null;
  } finally {
    if (shared) shared.fill(0);
    if (key) key.fill(0);
  }
}

function cardTag(actionKey, merchant, cardNumber) {
  const k = hkdf32(U.arrayify(actionKey), utf8(TAG_SALT), utf8(TEMPLATE_ID));
  try {
    return U.computeHmac("sha256", k, utf8(String(merchant) + "|" + cardNumber)).toLowerCase();
  } finally {
    k.fill(0);
  }
}

// One physical card, one tag. Best Buy reads an 18-digit number starting 88 as
// the 16 digits after it, so both forms are one card. A tag over the raw text
// would let one card be listed, and sold, once in each form.
function cardKey(merchant, cardNumber) {
  if (merchant === 1 && cardNumber.length === 18 && cardNumber.slice(0, 2) === "88") return cardNumber.slice(2);
  return cardNumber;
}

function moneyToCents(v) {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !MONEY_RE.test(s)) return null;
  const parts = s.split(".");
  const frac = parts.length === 2 ? (parts[1] + "0").slice(0, 2) : "00";
  const c = parseInt(parts[0], 10) * 100 + parseInt(frac, 10);
  return Number.isSafeInteger(c) ? c : null;
}

async function readBestBuy(card) {
  const n = cardKey(1, card.cardNumber);
  const res = await timedFetch("https://www.bestbuy.com/payment/1.0/giftcard/balance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json",
      "X-User-Interface": "DotCom-Optimized", "X-Client": "PAYMENT-AGG" },
    body: JSON.stringify({ cardNumber: n, pin: card.pin === null ? "" : card.pin })
  });
  if (!res || res.status !== 200) return null;
  const j = parseJson(res.text);
  return j !== null && typeof j === "object" ? moneyToCents(j.balance) : null;
}

function visitorId(actionKey, listingId) {
  const k = hkdf32(U.arrayify(actionKey), utf8(TAG_SALT), utf8(TEMPLATE_ID + "|nike"));
  try {
    const h = U.computeHmac("sha256", k, utf8(listingId)).slice(2, 34);
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
  } finally {
    k.fill(0);
  }
}

async function readNike(card, listingId, actionKey) {
  const res = await timedFetch("https://api.nike.com/payment/giftcard_balance/v1/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "appId": "orders",
      "x-nike-visitorid": visitorId(actionKey, listingId), "x-nike-visitid": "1" },
    body: JSON.stringify({ accountNumber: card.cardNumber, currency: "USD", pin: card.pin === null ? "" : card.pin })
  });
  if (!res || res.status !== 200) return null;
  // Nike's own page reads the balance from the top of the reply body.
  const j = parseJson(res.text);
  return j !== null && typeof j === "object" ? moneyToCents(j.balance) : null;
}

async function ticket(p) {
  const r = readManifest(p.manifest);
  if (!r) return DENIED;
  const m = r.m;
  const env = readEnvelope(p.envelope);
  if (!env) return DENIED;
  if (typeof p.depositor !== "string" || !ADDR_RE.test(p.depositor) || p.depositor === m.seller) return DENIED;
  if (typeof p.replyKeyHash !== "string" || !HEX32_RE.test(p.replyKeyHash) || p.replyKeyHash === ZERO32) return DENIED;
  const listingId = listingIdOf(m, env.sha);
  const c = await readGate(m.escrow, listingId, "0");
  if (!c || c.token !== TOKEN || c.listingState !== L_ACTIVE || c.listingSeller !== m.seller) return DENIED;
  if (c.time + 60 >= m.listingExpiry) return DENIED;

  // Every check that needs no key has passed. Only now is key material touched.
  let opened = null;
  try {
    const actionKey = await Lit.Actions.getLitActionPrivateKey();
    const identity = new U.SigningKey(actionKey);
    if (U.computeAddress(identity.publicKey).toLowerCase() !== c.signer) return DENIED;
    opened = await openCard(actionKey, env, p.manifest);
    if (!opened) return FAILED;
    const card = opened.card;
    if (!r.mc.card.test(card.cardNumber) || !pinOk(r.mc, card.pin)) return { ok: false, error: "card_invalid" };
    const tag = cardTag(actionKey, m.merchant, cardKey(m.merchant, card.cardNumber));
    let balance = 0;
    if (m.mode === 1) {
      let got = null;
      if (r.mc.reader === "bestbuy") got = await readBestBuy(card);
      if (r.mc.reader === "nike") got = await readNike(card, listingId, actionKey);
      if (got === null) return { ok: false, error: "balance_unavailable" };
      if (got < m.valueCents) return { ok: false, error: "balance_short" };
      if (got - m.valueCents > m.residualCapCents) return { ok: false, error: "balance_over" };
      balance = got;
    }
    const notAfter = Math.min(c.time + (m.mode === 1 ? TTL_READABLE_S : TTL_BLIND_S), m.listingExpiry - 1);
    const digest = openDigest(m.escrow, listingId, p.depositor, p.replyKeyHash, balance, tag, notAfter);
    return { ok: true, ticket: { listingId: listingId, depositor: p.depositor, replyKeyHash: p.replyKeyHash,
      openBalanceCents: balance, cardTag: tag, notAfter: notAfter,
      signature: U.joinSignature(identity.signDigest(digest)) } };
  } catch (e) {
    return FAILED;
  } finally {
    if (opened) opened.plain.fill(0);
  }
}

async function release(p) {
  const r = readManifest(p.manifest);
  if (!r) return DENIED;
  const m = r.m;
  const env = readEnvelope(p.envelope);
  if (!env) return DENIED;
  if (typeof p.depositId !== "string" || !ID_RE.test(p.depositId)) return DENIED;
  if (typeof p.replyKey !== "string" || !PUB_RE.test(p.replyKey)) return DENIED;
  try { U.computePublicKey(p.replyKey, false); } catch (e) { return DENIED; }
  const listingId = listingIdOf(m, env.sha);
  const c = await readGate(m.escrow, listingId, p.depositId);
  if (!c || c.token !== TOKEN) return DENIED;
  if (c.depositState !== D_OPENED && c.depositState !== D_RELEASED) return DENIED;
  if (c.depositListingId !== listingId) return DENIED;
  if (U.keccak256(p.replyKey).toLowerCase() !== c.replyKeyHash) return DENIED;

  // Every check that needs no key has passed. Only now is key material touched.
  let opened = null;
  let rshared = null;
  let rkey = null;
  let riv = null;
  try {
    const actionKey = await Lit.Actions.getLitActionPrivateKey();
    if (U.computeAddress(actionKey).toLowerCase() !== c.signer) return DENIED;
    opened = await openCard(actionKey, env, p.manifest);
    if (!opened) return FAILED;
    const payload = canonical({ chainId: CHAIN_ID, depositId: p.depositId, domain: REPLY_DOMAIN,
      escrow: m.escrow, manifestSha256: sha256Hex(p.manifest) });
    const info = REPLY_INFO + sha256Hex(payload);
    rshared = U.arrayify(opened.enc.computeSharedSecret(p.replyKey));
    rkey = hkdf32(rshared, U.arrayify(p.replyKey), utf8(info + "|key"));
    riv = hkdf32(rshared, U.arrayify(p.replyKey), utf8(info + "|iv"));
    const ek = await crypto.subtle.importKey("raw", rkey, { name: "AES-GCM" }, false, ["encrypt"]);
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: riv.slice(0, 12), additionalData: utf8(info), tagLength: 128 }, ek, opened.plain));
    return { ok: true, reply: U.base64.encode(sealed), payload: payload };
  } catch (e) {
    return FAILED;
  } finally {
    if (opened) opened.plain.fill(0);
    if (rshared) rshared.fill(0);
    if (rkey) rkey.fill(0);
    if (riv) riv.fill(0);
  }
}

async function bind(p) {
  if (typeof p.cid !== "string" || !CID_RE.test(p.cid)) return DENIED;
  const actionKey = await Lit.Actions.getLitActionPrivateKey();
  const identity = new ethers.Wallet(actionKey);
  const named = await Lit.Actions.getLitActionWalletAddress({ ipfsId: p.cid });
  if (typeof named !== "string" || named.toLowerCase() !== identity.address.toLowerCase()) return DENIED;
  const binding = canonical({ cid: p.cid, codehash: ESCROW_CODEHASH, domain: BIND_DOMAIN,
    encPub: encryptionKey(actionKey).compressedPublicKey.toLowerCase(), escrow: ESCROW, template: TEMPLATE_ID });
  return { ok: true, binding: binding, signature: await identity.signMessage(binding),
    identity: identity.address.toLowerCase() };
}

async function main(params) {
  try {
    if (typeof params !== "object" || params === null) return DENIED;
    if (params.op === "ticket") return await ticket(params);
    if (params.op === "release") return await release(params);
    if (params.op === "bind") return await bind(params);
    return DENIED;
  } catch (e) {
    return FAILED;
  }
}
`
