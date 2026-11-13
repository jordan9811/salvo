// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SalvoEscrowV2 ("salvo-escrow/2")
/// @notice Pay at the register for only the value used. One sealed gift-card listing is sold in
///   parts: each buyer pays the listing's discounted price for the cents they used, and the
///   cents left on the card stay listed, tracked here as `remainingCents`, for the next buyer.
///   The buyer who saw the card's number and left value on it also deposits that value at FACE
///   (`bond`), so spending it themselves gains nothing. The deposit comes back when the next
///   buyer's use of the remainder holds up, or pays the seller when the remainder turns out spent.
///   A ticket's balance read is from before that buyer pays, so at readable stores too the
///   deposit stays held through the next buyer's contest window: the read only stops the sale
///   of a remainder already short.
///
///   V2 does not read SalvoEscrowV1. Each Lit template keys its card tag with its own
///   CID-derived key, so the tag V2 sees for a card is never the tag V1 recorded, and V1's
///   cardOwner could never name it. A card V1 sold is kept off V2 off chain instead: no new V1
///   listings once V2 opens, and blind first sales here stay under the new-seller cap.
///
///   What stays from SalvoEscrowV1, unchanged: no owner or admin; litSigner and the token set
///   once by the constructor; RELEASE_DELAY 24 h, DISPUTE_HOLD 48 h, ticket TTL 15 min, $500 and
///   the $25 new-seller blind cap; owed and claim; sellerRefund root-only; payment and open in
///   ONE transaction, so the seller is paid into escrow before Lit opens the card.
/// @dev FROZEN: salvo-vault-escrow/2 pins keccak256 of this runtime code AND this contract's
///   address, for the reason V1's header gives: a code hash covers code, never storage, and
///   init code can preset `owed`, `sellerStats` or listings and then return this exact runtime.
///   So a deployment is trusted only together with its creation transaction, checked off chain
///   (src/lib/escrow/deployment.ts): a plain create from the deployer at nonce 0 whose input is
///   the compiled bytecode plus abi.encode(litSigner, token), byte for byte.
///   No owner, admin, fee, pause, upgrade, delegatecall or selfdestruct. Tempo: CALLVALUE is
///   always 0 and nothing here is payable.
///
///   MONEY LEAVES ONLY TO: a deposit's seller (release, a forfeited deposit, a confirmed
///   shortfall); the address that paid it in (a seller's refund, a deposit returned, a contested
///   sale's own payment, the reduceUse and keepRest differences); or an `owed` claimant.
///   Invariant: token balance == every Opened deposit's amount + every held bond + every owed.
contract SalvoEscrowV2 {
    // ------------------------------------------------------------------ types
    struct Terms {
        address seller;              // payout address; must be the listing's registrant
        uint96  price;               // token base units for the whole card (6 decimals)
        uint32  valueCents;          // card value being sold
        uint16  residualCapCents;    // most a sale may leave on the card; readable: also the most the
                                     // live balance may exceed what is left. <= 500 blind, <= 1000 readable
        uint16  remainderHaircutBps; // off the price of a remainder no deposit covers (Decision 3)
        uint8   merchant;            // template table: 1 bestbuy, 2 nike, 3 target, 4 walmart, 9 salvotest
        uint8   mode;                // 1 Lit reads the balance before opening, 2 blind
        uint40  listingExpiry;       // unix seconds
        bytes32 salt;                // 32 random bytes from the seller's browser
    }
    struct Ticket {
        bytes32 replyKeyHash;        // keccak256 of the shopper's 33-byte compressed secp256k1 reply key
        uint32  openBalanceCents;    // readable: the balance Lit read; blind: 0
        bytes32 cardTag;             // keyed fingerprint of the card, computed inside Lit
        uint32  remainingCents;      // the value left that Lit saw: valueCents before the first sale
        uint16  sales;               // the listing's sales that Lit saw, so a stale ticket reverts
        uint40  notAfter;            // last second the ticket is valid
        bytes   signature;           // 65 bytes r||s||v, low s, v in {27,28}
    }
    /// remainingCents is 0 until the first sale (the listing stays hidden until then; the value
    /// is the terms' valueCents). bondDeposit is the deposit whose bond covers the remainder, or
    /// whose bond a covering sale is still resolving. lastDeposit is the latest live sale.
    /// mode is copied from the terms at the first sale, for confirmRemainder.
    struct Listing {
        address seller; uint8 state; uint40 createdAt; uint32 remainingCents; uint16 sales;         // slot 0
        uint64 bondDeposit; uint40 bondSince; uint40 confirmedAt; uint64 lastDeposit; uint8 mode;    // slot 1
    }
    /// Slots 0-4 are V1's. covers: the deposit whose bond covered the remainder this sale used
    /// (the buyer's own, netted; or another buyer's, resolved after contestUntil). contestUntil
    /// is set only on that second kind: a remainder sale, blind or readable, by someone other
    /// than the bond's holder.
    struct Deposit {
        address depositor; uint40 openedAt; uint40 releaseAt; uint8 state; bool disputed;       // slot 0
        address seller; uint96 amount;                                                           // slot 1
        bytes32 listingId;                                                                       // slot 2
        bytes32 replyKeyHash;                                                                    // slot 3
        bytes32 cardTag;                                                                         // slot 4
        uint32 usedCents; uint32 leftAfterCents; uint16 saleIndex; uint64 bond; uint8 bondState;
        uint64 covers; uint40 contestUntil;                                                      // slot 5
    }
    /// paidOut: token units release() has paid this seller, summed. The blind cap grows with it.
    /// remaindersShort: remainders found short (contested, or a confirm read below what was
    /// left). bondsClaimed: deposits the seller took by saying the remainder was spent.
    struct SellerStats {
        uint32 sold; uint32 disputes; uint32 refunds; uint96 paidOut; uint32 remaindersShort; uint32 bondsClaimed;
    }

    // ------------------------------------------------------------------ constants
    string  public constant VERSION = "salvo-escrow/2";
    uint8   public constant MODE_READABLE = 1;
    uint8   public constant MODE_BLIND = 2;
    uint8   public constant LISTING_ACTIVE = 1;
    uint8   public constant LISTING_DRAINED = 2;
    uint8   public constant LISTING_CANCELLED = 3;
    uint8   public constant LISTING_SPENT = 4;
    uint8   public constant DEPOSIT_OPENED = 1;
    uint8   public constant DEPOSIT_RELEASED = 2;
    uint8   public constant DEPOSIT_REFUNDED = 3;
    uint8   public constant DEPOSIT_CONTESTED = 4;
    uint8   public constant BOND_NONE = 0;
    uint8   public constant BOND_HELD = 1;
    uint8   public constant BOND_RETURNED = 2;
    uint8   public constant BOND_FORFEITED = 3;

    uint256 public constant UNITS_PER_CENT = 10_000;          // 6-decimal token, checked in the constructor
    uint256 public constant BPS = 10_000;
    uint256 public constant RELEASE_DELAY = 24 hours;
    uint256 public constant DISPUTE_HOLD = 48 hours;
    uint256 public constant MAX_TICKET_TTL = 15 minutes;
    uint256 public constant MAX_VALUE_CENTS = 50_000;         // $500
    /// A blind card above this needs at least its value already paid out to its seller.
    uint256 public constant NEW_SELLER_BLIND_CAP_CENTS = 2_500; // $25
    uint256 public constant CAP_BLIND = 500;                  // $5 left at most where nobody can read it
    uint256 public constant CAP_READABLE = 1_000;             // $10 where Lit reads the balance
    uint256 public constant CONTEST_WINDOW = 2 hours;
    uint256 public constant BOND_REVIEW_AFTER = 5 days;
    uint256 public constant BOND_MAX_AGE = 7 days;
    /// A buyer's window at a readable store: a confirm read at least this long after their sale
    /// that finds the remainder whole closes it. A sooner read, which they could post themselves
    /// before scanning, does not.
    uint256 public constant CONFIRM_DELAY = 15 minutes;

    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint16 remainderHaircutBps,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)");
    bytes32 public constant LISTING_TYPEHASH = keccak256("SalvoListing(bytes32 coreHash,bytes32 envelopeHash)");
    bytes32 public constant OPEN_TYPEHASH = keccak256(
        "OpenV2(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint32 remainingCents,uint16 sales,uint40 notAfter)");
    bytes32 public constant CONFIRM_TYPEHASH = keccak256(
        "Confirm(bytes32 listingId,uint64 bondDeposit,uint32 balance,uint40 readAt)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("SalvoEscrow");
    bytes32 private constant VERSION_HASH = keccak256("2");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ------------------------------------------------------------------ storage (set once; no setters)
    address public litSigner;
    address public token;
    uint256 public depositCount;
    uint256 private _lock = 1;
    mapping(bytes32 => Listing) private _listings;
    mapping(uint256 => Deposit) private _deposits;
    mapping(bytes32 => address) public cardOwner;      // cardTag => who may sell this card next
    mapping(bytes32 => uint256) public cardDeposit;    // cardTag => the purchase that made cardOwner the owner; 0 if none
    mapping(bytes32 => bytes32) public cardListing;    // cardTag => its one live listing with a remainder; 0 if none
    mapping(address => SellerStats) public sellerStats;
    mapping(address => uint32) public buyerShortfalls; // remainders this buyer left that were found short
    mapping(address => uint256) public owed;           // payouts a recipient's token policy refused

    // ------------------------------------------------------------------ events
    event Listed(bytes32 indexed listingId, address indexed seller, bytes32 commitment);
    event ListingCancelled(bytes32 indexed listingId);
    event Opened(uint256 indexed depositId, bytes32 indexed listingId, address indexed depositor,
                 bytes32 cardTag, uint32 openBalanceCents, uint40 releaseAt);
    /// Every sale: the cents it used, the cents it left on the card, and the bond it deposited for them.
    event Used(bytes32 indexed listingId, uint256 indexed depositId, uint32 usedCents, uint32 leftCents, uint256 bond);
    event Disputed(uint256 indexed depositId, bytes32 reasonHash, uint40 releaseAt);
    event Contested(uint256 indexed depositId, uint256 indexed covers, bytes32 reasonHash);
    event Rekeyed(uint256 indexed depositId, bytes32 replyKeyHash);
    event Released(uint256 indexed depositId, uint256 amount);
    /// Emitted for every refund of a sale's payment, part or full, by the seller or by a contest.
    /// `remaining` is what the deposit still holds for the seller. Read the state from
    /// getDeposit(id).state, never from the event's name.
    event Refunded(uint256 indexed depositId, uint256 toDepositor, uint256 remaining);
    event BondReturned(uint256 indexed depositId, uint256 amount);
    event BondForfeited(uint256 indexed depositId, uint256 amount);
    event RemainderConfirmed(bytes32 indexed listingId, uint32 balanceCents, uint40 readAt, uint256 toSeller);
    event RemainderClosed(bytes32 indexed listingId, bool spent);
    event UseReduced(uint256 indexed depositId, uint32 usedCents, uint32 leftCents, uint256 refund);
    event RestKept(uint256 indexed depositId, uint32 restCents, uint256 restPrice);
    event Owed(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);

    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }

    constructor(address litSigner_, address token_) {
        require(litSigner_ != address(0), "signer");
        require(token_.code.length > 0, "token");                 // TIP-20 precompile code is 0xef (length 1)
        (bool ok, bytes memory ret) = token_.staticcall(abi.encodeWithSelector(0x313ce567));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) == 6, "decimals");
        litSigner = litSigner_;
        token = token_;
    }

    // ------------------------------------------------------------------ seller
    /// Registers a hidden listing. The id includes msg.sender, so nobody can front-run it.
    function list(bytes32 commitment) external returns (bytes32 listingId) {
        require(commitment != bytes32(0), "commitment");
        listingId = listingIdOf(msg.sender, commitment);
        Listing storage l = _listings[listingId];
        require(l.state == 0, "exists");
        l.seller = msg.sender;
        l.state = LISTING_ACTIVE;
        l.createdAt = uint40(block.timestamp);
        emit Listed(listingId, msg.sender, commitment);
    }

    /// Unsold, or the seller marking a remainder "I used it myself". Any held deposit goes back
    /// to its holder. Never while a sale is still resolving the remainder (the listing is then
    /// Drained, not Active).
    function cancelListing(bytes32 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.seller == msg.sender, "not seller");
        require(l.state == LISTING_ACTIVE, "not active");
        l.state = LISTING_CANCELLED;
        if (l.sales > 0) cardListing[_deposits[l.lastDeposit].cardTag] = bytes32(0);
        uint256 b = l.bondDeposit;
        address holder = _deposits[b].depositor;
        uint256 back = b == 0 ? 0 : _takeBond(b, BOND_RETURNED);
        emit ListingCancelled(listingId);
        _pay(holder, back);
    }

    /// The seller's money back to a shopper. Root passkey only (never in an access-key scope).
    /// As in V1, a part refund moves only the shopper's share and leaves the deposit Opened.
    /// Refunding everything left ends the sale and gives the card back to the seller. It moves
    /// that sale's payment and nothing else: it lists nothing again, since the refunded buyer
    /// has seen the number, and every deposit stays held and resolves by its own rules, so a
    /// refund never frees one. So a buyer's own remainder sale refunded leaves its deposit
    /// covering what it left, and a covering sale refunded leaves the deposit it covered to its
    /// window. One exception: a first sale that is still the listing's latest closes the
    /// listing, as V1 never relists, and its own deposit comes back with the refund, as on
    /// cancelListing. Nobody else has seen the number then.
    function sellerRefund(uint256 id, uint96 refundAmount) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.seller, "not seller");
        require(d.state == DEPOSIT_OPENED, "state");
        require(refundAmount > 0 && refundAmount <= d.amount, "amount");
        uint96 remaining = d.amount - refundAmount;
        d.amount = remaining;
        sellerStats[d.seller].refunds += 1;
        uint256 back = 0;
        if (remaining == 0) {
            d.state = DEPOSIT_REFUNDED;
            if (cardDeposit[d.cardTag] == id) {
                cardOwner[d.cardTag] = d.seller;
                cardDeposit[d.cardTag] = 0;
            }
            back = _closeFirstSale(id, d);
        }
        emit Refunded(id, refundAmount, remaining);
        _pay(d.depositor, uint256(refundAmount) + back);
    }

    /// After BOND_REVIEW_AFTER, the seller says what became of an unsold remainder. Root passkey
    /// only. spent: the deposit pays the seller and the listing is Spent; this is the seller's
    /// word, so it counts publicly (bondsClaimed), and it is open only until BOND_MAX_AGE, when
    /// the deposit returns by rule. Not spent: the deposit goes back and the remainder stays
    /// listed with no deposit.
    function sellerCloseRemainder(bytes32 listingId, bool spent) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.seller == msg.sender, "not seller");
        require(l.state == LISTING_ACTIVE, "not active");      // a covering sale drains the listing
        uint256 b = l.bondDeposit;
        require(b != 0, "no deposit");
        uint256 since = l.bondSince;
        require(block.timestamp >= since + BOND_REVIEW_AFTER, "too early");
        Deposit storage x = _deposits[b];
        address to = x.depositor;
        if (spent) {
            require(block.timestamp < since + BOND_MAX_AGE, "too late");
            l.state = LISTING_SPENT;
            l.remainingCents = 0;
            cardListing[x.cardTag] = bytes32(0);
            sellerStats[msg.sender].bondsClaimed += 1;
            to = msg.sender;
        }
        uint256 amount = _takeBond(b, spent ? BOND_FORFEITED : BOND_RETURNED);
        emit RemainderClosed(listingId, spent);
        _pay(to, amount);
    }

    // ------------------------------------------------------------------ shopper
    /// Pay for `usedCents` of a listing and open it, in one step. Valid only with a litSigner
    /// ticket naming msg.sender and the listing's current value left and sales count.
    ///
    /// The ticket fixes who may open and the state of the listing; this function alone prices
    /// the claimed use. Let R be the value left (valueCents before the first sale). Then
    /// 0 < usedCents <= R, and R - usedCents, the cents left on the card, is at most the cap and
    /// is deposited at face. A remainder some other buyer's deposit covers is used whole.
    function depositAndOpen(Terms calldata t, bytes32 envelopeHash, uint32 usedCents, Ticket calldata k)
        external nonReentrant returns (uint256 id)
    {
        bytes32 listingId = _checkTerms(t, envelopeHash);
        (uint32 left, uint256 amount) = _priceUse(t, listingId, usedCents, k);
        id = _record(t, listingId, k, usedCents, left, amount);
        _settle(_listings[listingId], k.cardTag, id, left, amount);
    }

    /// Records a complaint: moves no money, holds the payout DISPUTE_HOLD longer, counts publicly.
    function dispute(uint256 id, bytes32 reasonHash) external {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.depositor, "not depositor");
        require(d.state == DEPOSIT_OPENED && !d.disputed, "no dispute");
        require(block.timestamp < d.releaseAt, "too late");
        d.disputed = true;
        d.releaseAt = uint40(uint256(d.releaseAt) + DISPUTE_HOLD);
        sellerStats[d.seller].disputes += 1;
        emit Disputed(id, reasonHash, d.releaseAt);
    }

    /// "That card was empty": a remainder sale covered by another buyer's deposit, blind or
    /// readable, within CONTEST_WINDOW of the sale. The sale is refunded from its own pending payment, the
    /// covering deposit pays the seller (at face, so at least what this buyer paid), and the
    /// listing is Spent. Decision 1: no seller verdict is waited for.
    function contestRemainder(uint256 id, bytes32 reasonHash) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.depositor, "not depositor");
        require(d.state == DEPOSIT_OPENED, "state");
        require(d.contestUntil != 0, "not a remainder sale");
        require(block.timestamp < d.contestUntil, "too late");
        uint256 x = d.covers;
        Deposit storage b = _deposits[x];
        uint256 refund = d.amount;
        d.state = DEPOSIT_CONTESTED;
        d.amount = 0;
        if (cardDeposit[d.cardTag] == id) {
            cardOwner[d.cardTag] = d.seller;
            cardDeposit[d.cardTag] = 0;
        }
        _listings[d.listingId].state = LISTING_SPENT;
        sellerStats[d.seller].remaindersShort += 1;
        buyerShortfalls[b.depositor] += 1;
        uint256 forfeit = b.bondState == BOND_HELD ? _takeBond(x, BOND_FORFEITED) : 0;
        emit Contested(id, x, reasonHash);
        emit Refunded(id, refund, 0);
        _pay(d.depositor, refund);
        _pay(d.seller, forfeit);
    }

    /// The total went down: claim fewer cents used on the latest sale, before its payout. Not on
    /// a remainder sale (only on a first sale or your own remainder). The new leftover must fit
    /// the cap. The price difference comes back and the deposit rises by the face of the cents
    /// given back, in one pull: face is never less than price, so it is always a pull. Reopens a
    /// listing this sale drained.
    function reduceUse(Terms calldata t, bytes32 envelopeHash, uint256 id, uint32 newUsedCents) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.depositor, "not depositor");
        require(d.state == DEPOSIT_OPENED && block.timestamp < d.releaseAt, "state");
        bytes32 listingId = d.listingId;
        require(listingIdOf(t.seller, commitmentOf(t, envelopeHash)) == listingId, "terms");
        Listing storage l = _listings[listingId];
        require(l.lastDeposit == id, "not latest");
        require(_firstOrOwn(d), "remainder sale");
        bool drained = l.state == LISTING_DRAINED;
        require(drained || (l.state == LISTING_ACTIVE && l.bondDeposit == id), "listing");
        require(newUsedCents > 0 && newUsedCents < d.usedCents, "used");
        uint32 more = d.usedCents - newUsedCents;
        uint32 left = l.remainingCents + more;                 // a drained listing has 0 left
        require(left <= t.residualCapCents, "left");
        uint256 newAmount = priceFor(t.price, t.valueCents, newUsedCents, 0);
        uint256 refund = d.amount - newAmount;
        uint256 raise = uint256(more) * UNITS_PER_CENT;
        d.usedCents = newUsedCents;
        d.leftAfterCents += more;
        d.amount = uint96(newAmount);
        d.bond += uint64(raise);
        d.bondState = BOND_HELD;
        l.remainingCents = left;
        if (drained) {
            bytes32 tag = d.cardTag;
            l.state = LISTING_ACTIVE;
            l.bondDeposit = uint64(id);
            l.bondSince = uint40(block.timestamp);
            cardListing[tag] = listingId;
            if (cardDeposit[tag] == id) {
                cardOwner[tag] = d.seller;
                cardDeposit[tag] = 0;
            }
        }
        emit UseReduced(id, newUsedCents, left, refund);
        _pull(msg.sender, raise - refund);
    }

    /// The register said paid before the leftover was used: keep the rest of this card as your
    /// own credit. Buys what is left at this sale's price out of its own deposit and returns the
    /// rest of the deposit. The card becomes the buyer's, as a V1 purchase does.
    function keepRest(Terms calldata t, bytes32 envelopeHash, uint256 id) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.depositor, "not depositor");
        require(d.state == DEPOSIT_OPENED, "state");
        require(listingIdOf(t.seller, commitmentOf(t, envelopeHash)) == d.listingId, "terms");
        Listing storage l = _listings[d.listingId];
        require(l.state == LISTING_ACTIVE && l.lastDeposit == id && l.bondDeposit == id, "no rest");
        uint32 rest = l.remainingCents;
        // A sale of a remainder no deposit covered was priced with the haircut; so is its rest.
        uint256 restPrice = priceFor(t.price, t.valueCents, rest,
            d.saleIndex > 0 && d.covers == 0 ? t.remainderHaircutBps : 0);
        uint256 back = uint256(d.bond) - restPrice;           // the bond is the rest at face, never less than its price
        d.amount += uint96(restPrice);
        d.usedCents += rest;
        d.leftAfterCents = 0;
        d.bond = 0;
        d.bondState = BOND_RETURNED;
        l.bondDeposit = 0;
        _drain(l, d.cardTag, id, msg.sender);
        emit RestKept(id, rest, restPrice);
        emit BondReturned(id, back);
        _pay(msg.sender, back);
    }

    /// Lost phone: point future releases at a new device key. Root passkey only.
    function rekey(uint256 id, bytes32 replyKeyHash) external {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.depositor, "not depositor");
        require(replyKeyHash != bytes32(0), "reply key");
        require(d.state == DEPOSIT_OPENED || d.state == DEPOSIT_RELEASED, "state");
        d.replyKeyHash = replyKeyHash;
        emit Rekeyed(id, replyKeyHash);
    }

    // ------------------------------------------------------------------ anyone
    /// After releaseAt (and after contestUntil): the seller is paid, and the deposit this sale
    /// covered, if still held, goes back to its holder. Anyone may call.
    function release(uint256 id) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(d.state == DEPOSIT_OPENED, "state");
        require(block.timestamp >= d.releaseAt && block.timestamp >= d.contestUntil, "too early");
        d.state = DEPOSIT_RELEASED;
        SellerStats storage s = sellerStats[d.seller];
        s.sold += 1;
        s.paidOut += d.amount;
        uint256 x = d.covers;
        address holder = _deposits[x].depositor;
        uint256 back = d.contestUntil != 0 && _deposits[x].bondState == BOND_HELD ? _takeBond(x, BOND_RETURNED) : 0;
        emit Released(id, d.amount);
        _pay(d.seller, d.amount);
        _pay(holder, back);
    }

    /// Returns a held deposit to its holder when (a) the sale covering it passed contestUntil
    /// uncontested (paid out, still pending, or refunded by its seller), (b) the listing is
    /// Cancelled, or (c) it is BOND_MAX_AGE old with no covering sale inside its contest window.
    /// In case (c) the listing stays Active with no deposit. Anyone may call; it pays only the
    /// holder. A contested covering sale has already forfeited the deposit.
    function releaseBond(uint256 id) external nonReentrant {
        Deposit storage x = _deposits[id];
        require(x.bondState == BOND_HELD, "not held");
        Listing storage l = _listings[x.listingId];
        uint256 c = l.lastDeposit;
        Deposit storage cd = _deposits[c];
        bool due;
        if (c != id && cd.covers == id && cd.contestUntil != 0) {
            due = block.timestamp >= cd.contestUntil;                                      // (a)
        } else {
            // (b) is a backstop: cancelListing already returns the deposit.
            due = l.state == LISTING_CANCELLED || block.timestamp >= uint256(l.bondSince) + BOND_MAX_AGE;
        }
        require(due, "bond held");
        address holder = x.depositor;
        _pay(holder, _takeBond(id, BOND_RETURNED));
    }

    /// Readable listings only. Lit read the card's balance at readAt and signed
    /// Confirm(listingId, bondDeposit, balance, readAt); readAt is after the covering deposit (or
    /// the latest sale) opened and after the last confirm. A balance below what is left moves
    /// min(shortfall at face, bond) to the seller only, and lowers what is left to the balance.
    /// It can never raise it. A shortfall counts against one side, never both: against the
    /// deposit's buyer while their window is open, that is, unless an earlier read at least
    /// CONFIRM_DELAY after their sale found the remainder whole; against the seller after that,
    /// or when no deposit is left. Either way the deposit pays the seller.
    function confirmRemainder(bytes32 listingId, uint32 balance, uint40 readAt, bytes calldata sig) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.state == LISTING_ACTIVE && l.sales > 0, "no remainder");
        require(l.mode == MODE_READABLE, "mode");
        uint256 b = l.bondDeposit;
        Deposit storage x = _deposits[b != 0 ? b : uint256(l.lastDeposit)];
        uint40 lastRead = l.confirmedAt;
        require(readAt > x.openedAt && readAt > lastRead && readAt <= block.timestamp, "read time");
        require(_recover(confirmDigest(listingId, uint64(b), balance, readAt), sig) == litSigner, "not lit");
        l.confirmedAt = readAt;
        uint32 have = l.remainingCents;
        uint256 toSeller = 0;
        if (balance < have) {
            l.remainingCents = balance;
            bool buyers = b != 0 && uint256(lastRead) < uint256(x.openedAt) + CONFIRM_DELAY;
            if (buyers) buyerShortfalls[x.depositor] += 1;
            else sellerStats[l.seller].remaindersShort += 1;
            if (b != 0) toSeller = _shortfall(x, b, uint256(have - balance) * UNITS_PER_CENT);
        }
        uint256 back = 0;
        if (balance == 0) {
            l.state = LISTING_SPENT;
            cardListing[x.cardTag] = bytes32(0);
            if (b != 0 && x.bondState == BOND_HELD) back = _takeBond(b, BOND_RETURNED);
        }
        emit RemainderConfirmed(listingId, balance, readAt, toSeller);
        _pay(l.seller, toSeller);
        _pay(x.depositor, back);
    }

    /// Retry a payout the token refused earlier. Pays only `to`.
    function claim(address to) external nonReentrant {
        uint256 a = owed[to];
        require(a > 0, "nothing owed");
        owed[to] = 0;
        require(_tryTransfer(to, a), "transfer failed");
        emit Claimed(to, a);
    }

    // ------------------------------------------------------------------ views
    /// Everything the Lit template checks, in ONE eth_call: V1's 8 static words plus the
    /// listing's value left, its sales count and the deposit covering its remainder (11 words).
    function gate(bytes32 listingId, uint256 depositId) external view returns (
        address signer, address tokenAddress, address listingSeller, uint8 listingState,
        uint8 depositState, bytes32 depositListingId, bytes32 replyKeyHash, address depositor,
        uint32 remainingCents, uint16 sales, uint64 bondDeposit)
    {
        Listing storage l = _listings[listingId];
        Deposit storage d = _deposits[depositId];
        signer = litSigner;
        tokenAddress = token;
        listingSeller = l.seller;
        listingState = l.state;
        depositState = d.state;
        depositListingId = d.listingId;
        replyKeyHash = d.replyKeyHash;
        depositor = d.depositor;
        remainingCents = l.remainingCents;
        sales = l.sales;
        bondDeposit = l.bondDeposit;
    }
    function getListing(bytes32 listingId) external view returns (Listing memory) { return _listings[listingId]; }
    function getDeposit(uint256 id) external view returns (Deposit memory) { return _deposits[id]; }

    /// What `usedCents` of a card costs: ceil(used * price * (1 - haircut) / value), in token
    /// units. With no haircut this is legCostCents (src/lib/demand/quote.ts) in token units.
    /// Rounds up, so a rounding error never comes out of the seller's side.
    function priceFor(uint256 price, uint256 valueCents, uint256 usedCents, uint256 haircutBps) public pure returns (uint256) {
        require(valueCents > 0 && haircutBps < BPS, "price args");
        uint256 n = usedCents * price * (BPS - haircutBps);
        uint256 q = valueCents * BPS;
        return n == 0 ? 0 : (n - 1) / q + 1;
    }

    function coreHashOf(Terms calldata t) public view returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, block.chainid, address(this), token, t));
    }
    function commitmentOf(Terms calldata t, bytes32 envelopeHash) public view returns (bytes32) {
        return keccak256(abi.encode(LISTING_TYPEHASH, coreHashOf(t), envelopeHash));
    }
    function listingIdOf(address seller, bytes32 commitment) public pure returns (bytes32) {
        return keccak256(abi.encode(seller, commitment));
    }
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
    /// The ticket digest. `k.signature` is not part of it.
    function openDigest(bytes32 listingId, address depositor, Ticket calldata k) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            OPEN_TYPEHASH, listingId, depositor, k.replyKeyHash, k.openBalanceCents, k.cardTag,
            k.remainingCents, k.sales, k.notAfter));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }
    function confirmDigest(bytes32 listingId, uint64 bondDeposit, uint32 balance, uint40 readAt) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(CONFIRM_TYPEHASH, listingId, bondDeposit, balance, readAt));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ internals
    function _checkTerms(Terms calldata t, bytes32 envelopeHash) private view returns (bytes32 listingId) {
        require(t.mode == MODE_READABLE || t.mode == MODE_BLIND, "mode");
        require(t.valueCents > 0 && t.valueCents <= MAX_VALUE_CENTS, "value");
        require(t.price > 0 && uint256(t.price) <= uint256(t.valueCents) * UNITS_PER_CENT, "price");
        require(t.residualCapCents <= (t.mode == MODE_BLIND ? CAP_BLIND : CAP_READABLE), "cap");
        require(t.remainderHaircutBps < BPS, "haircut");
        require(block.timestamp < t.listingExpiry, "listing expired");
        require(msg.sender != t.seller, "own listing");
        // As V1: a blind card above $25 needs its seller already paid at least its value.
        if (t.mode == MODE_BLIND && t.valueCents > NEW_SELLER_BLIND_CAP_CENTS) {
            require(uint256(sellerStats[t.seller].paidOut) >= uint256(t.valueCents) * UNITS_PER_CENT, "new seller cap");
        }
        listingId = listingIdOf(t.seller, commitmentOf(t, envelopeHash));
        require(_listings[listingId].state == LISTING_ACTIVE, "listing not active");
    }

    function _checkTicket(Terms calldata t, bytes32 listingId, uint16 sales, uint32 have, Ticket calldata k) private view {
        require(k.replyKeyHash != bytes32(0), "reply key");
        require(k.cardTag != bytes32(0), "card tag");
        require(k.remainingCents == have && k.sales == sales, "stale ticket");
        address current = cardOwner[k.cardTag];
        require(current == address(0) || current == t.seller, "card not seller's");
        // As V1: a buyer may resell a card only once their own purchase of it is paid out.
        uint256 boughtIn = cardDeposit[k.cardTag];
        require(boughtIn == 0 || _deposits[boughtIn].state == DEPOSIT_RELEASED, "card not paid out");
        // One live listing per physical card; a remainder is sold only under the card it began with.
        bytes32 live = cardListing[k.cardTag];
        require(sales == 0 ? live == bytes32(0) : live == listingId, "card listed");
        require(block.timestamp <= k.notAfter && uint256(k.notAfter) <= block.timestamp + MAX_TICKET_TTL, "ticket time");
        if (t.mode == MODE_READABLE) {
            require(k.openBalanceCents >= have && k.openBalanceCents - have <= t.residualCapCents, "balance");
        } else {
            require(k.openBalanceCents == 0, "blind balance");
        }
        require(_recover(openDigest(listingId, msg.sender, k), k.signature) == litSigner, "not lit");
    }

    /// Checks the ticket against the listing's value left (R) and sales count, and prices the use:
    /// 0 < used <= R, the cents left at most the cap, a remainder another buyer's deposit covers
    /// used whole. Decision 3: the haircut comes off the price only when no deposit covers it.
    function _priceUse(Terms calldata t, bytes32 listingId, uint32 usedCents, Ticket calldata k)
        private view returns (uint32 left, uint256 amount)
    {
        Listing storage l = _listings[listingId];
        uint16 sales = l.sales;
        uint32 have = sales == 0 ? t.valueCents : l.remainingCents;
        _checkTicket(t, listingId, sales, have, k);
        require(usedCents > 0 && usedCents <= have, "used");
        left = have - usedCents;
        require(left <= t.residualCapCents, "left");
        uint256 prior = l.bondDeposit;
        require(prior == 0 || left == 0 || _deposits[prior].depositor == msg.sender, "remainder whole");
        amount = priceFor(t.price, t.valueCents, usedCents, sales > 0 && prior == 0 ? t.remainderHaircutBps : 0);
    }

    /// After the sale's books: settle the deposit that covered the remainder, close the listing
    /// or bond the new leftover, then move the money. The buyer's own deposit is netted into
    /// their payment, so it is one transfer either way. Another buyer's deposit stays held
    /// until contestUntil, at blind and readable stores alike: the next buyer's use is the proof,
    /// and a ticket's balance read is from before they paid, while the earlier buyer still knows
    /// the number.
    function _settle(Listing storage l, bytes32 tag, uint256 id, uint32 left, uint256 amount) private {
        uint256 prior = l.bondDeposit;
        address holder = _deposits[prior].depositor;
        bool own = prior != 0 && holder == msg.sender;
        uint256 back = 0;
        if (prior != 0) {
            _deposits[id].covers = uint64(prior);
            if (own) back = _takeBond(prior, BOND_RETURNED);
            else _deposits[id].contestUntil = uint40(block.timestamp + CONTEST_WINDOW);
        }
        if (left == 0) {
            _drain(l, tag, id, msg.sender);
        } else {
            l.bondDeposit = uint64(id);
            l.bondSince = uint40(block.timestamp);
        }
        // Effects above, transfers last. The price and the bond are one pull.
        uint256 due = amount + uint256(left) * UNITS_PER_CENT;
        if (own) {
            if (due >= back) _pull(msg.sender, due - back);
            else _pay(msg.sender, back - due);
        } else {
            _pull(msg.sender, due);
            _pay(holder, back);
        }
    }

    /// The sale's books. The listing moves on here; _settle then settles the remainder's deposit.
    function _record(Terms calldata t, bytes32 listingId, Ticket calldata k, uint32 used, uint32 left, uint256 amount)
        private returns (uint256 id)
    {
        id = ++depositCount;
        Listing storage l = _listings[listingId];
        Deposit storage d = _deposits[id];
        uint40 releaseAt = uint40(block.timestamp + RELEASE_DELAY);
        d.depositor = msg.sender;
        d.openedAt = uint40(block.timestamp);
        d.releaseAt = releaseAt;
        d.state = DEPOSIT_OPENED;
        d.seller = t.seller;
        d.amount = uint96(amount);
        d.listingId = listingId;
        d.replyKeyHash = k.replyKeyHash;
        d.cardTag = k.cardTag;
        d.usedCents = used;
        d.leftAfterCents = left;
        d.saleIndex = l.sales;
        uint256 bond = uint256(left) * UNITS_PER_CENT;
        if (left > 0) {
            d.bond = uint64(bond);
            d.bondState = BOND_HELD;
            cardListing[k.cardTag] = listingId;
        }
        if (l.sales == 0) l.mode = t.mode;
        l.sales += 1;
        l.lastDeposit = uint64(id);
        l.remainingCents = left;
        emit Opened(id, listingId, msg.sender, k.cardTag, k.openBalanceCents, releaseAt);
        emit Used(listingId, id, used, left, bond);
    }

    /// No value left to sell. Whoever bought the last of it owns the card, as a V1 buyer does.
    function _drain(Listing storage l, bytes32 tag, uint256 id, address buyer) private {
        l.state = LISTING_DRAINED;
        l.remainingCents = 0;
        cardListing[tag] = bytes32(0);
        cardOwner[tag] = buyer;
        cardDeposit[tag] = id;
    }

    /// Takes a held bond off the books (returned to its holder or forfeited to the seller) and
    /// says how much. Pays nothing: every caller pays after its effects.
    function _takeBond(uint256 id, uint8 outcome) private returns (uint256 amount) {
        Deposit storage x = _deposits[id];
        amount = x.bond;
        x.bond = 0;
        x.bondState = outcome;
        Listing storage l = _listings[x.listingId];
        if (l.bondDeposit == id) l.bondDeposit = 0;
        if (outcome == BOND_RETURNED) emit BondReturned(id, amount);
        else emit BondForfeited(id, amount);
    }

    /// A confirmed shortfall: up to `faceShort` of the bond goes to the seller. A bond taken
    /// whole is forfeited; a part leaves the rest held, still covering what is left.
    function _shortfall(Deposit storage x, uint256 b, uint256 faceShort) private returns (uint256 toSeller) {
        uint256 held = x.bond;
        toSeller = faceShort < held ? faceShort : held;
        if (toSeller == held) {
            _takeBond(b, BOND_FORFEITED);
        } else {
            x.bond = uint64(held - toSeller);
            emit BondForfeited(b, toSeller);
        }
    }

    /// A first sale refunded in full while it is still the listing's latest, with the listing
    /// Active or Drained: the listing closes (Cancelled), and the sale's own deposit, if still
    /// held, comes back with the refund. Any other full refund changes no listing and no
    /// deposit, and returns 0.
    function _closeFirstSale(uint256 id, Deposit storage d) private returns (uint256 back) {
        bytes32 listingId = d.listingId;
        Listing storage l = _listings[listingId];
        if (d.saleIndex != 0 || l.lastDeposit != id) return 0;
        if (l.state != LISTING_ACTIVE && l.state != LISTING_DRAINED) return 0;
        l.state = LISTING_CANCELLED;
        cardListing[d.cardTag] = bytes32(0);
        if (d.bondState == BOND_HELD) back = _takeBond(id, BOND_RETURNED);
        emit ListingCancelled(listingId);
    }

    /// A first sale, or a sale of the buyer's own bonded remainder: the only sales reduceUse may change.
    function _firstOrOwn(Deposit storage d) private view returns (bool) {
        return d.saleIndex == 0 || (d.covers != 0 && _deposits[d.covers].depositor == d.depositor);
    }


    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address a) {
        require(sig.length == 65, "sig length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        require(uint256(s) <= HALF_N, "sig s");
        require(v == 27 || v == 28, "sig v");
        a = ecrecover(digest, v, r, s);
        require(a != address(0), "sig");
    }

    function _balanceOf(address account) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        require(ok && ret.length == 32, "balanceOf");
        return abi.decode(ret, (uint256));
    }

    function _pull(address from, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = _balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        require(ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool)))), "pull");
        require(_balanceOf(address(this)) - before == amount, "pull amount");   // refuses fee-on-transfer
    }

    /// A blocked recipient never strands the other party: the amount becomes `owed`.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        if (!_tryTransfer(to, amount)) { owed[to] += amount; emit Owed(to, amount); }
    }

    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
