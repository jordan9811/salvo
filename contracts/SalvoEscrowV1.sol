// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SalvoEscrowV1 ("salvo-escrow/1")
/// @notice One purchase of one sealed gift-card listing, paid in one pinned 6-decimal stablecoin.
///   The shopper's payment and the "opened" record are ONE transaction (depositAndOpen), valid
///   only with a ticket signed by the Lit action whose CID-derived address is `litSigner`. From
///   then the money belongs to the listing's seller: paid out RELEASE_DELAY later (plus
///   DISPUTE_HOLD if the shopper disputes), less whatever the seller chose to refund. There is
///   no unopened deposit, so nothing ever times out back to anyone.
/// @dev FROZEN: salvo-vault-escrow/1 pins keccak256 of this runtime code AND this contract's
///   address. No owner, admin, fee, pause, upgrade, delegatecall or selfdestruct. litSigner and
///   token are storage, not immutable, so the runtime code hash does not depend on them. A code
///   hash covers code, never storage: a copy of this code deployed by custom init code could
///   start with any storage it likes (a litSigner, owed balances, sales). That is why the
///   template also pins the address, which is the deployer's first CREATE address and so is
///   known before the template's CID. The address is not enough on its own: the deployer
///   chooses the init code that runs at it, and init code can preset `owed` or `sellerStats`
///   and then return this exact runtime. So a deployment is trusted only together with its
///   creation transaction, checked off chain (src/lib/escrow/deployment.ts,
///   verifyEscrowCreation): a plain create from the deployer at nonce 0 whose input is the
///   compiled bytecode plus abi.encode(litSigner, token), byte for byte, that succeeded at the
///   pinned address. Tempo: CALLVALUE is always 0 and nothing here is payable.
contract SalvoEscrowV1 {
    // ------------------------------------------------------------------ types
    struct Terms {
        address seller;            // payout address; must be the listing's registrant
        uint96  price;             // token base units the shopper pays (6 decimals)
        uint32  valueCents;        // card value being sold
        uint16  residualCapCents;  // readable mode: most the live balance may exceed valueCents
        uint8   merchant;          // template table: 1 bestbuy, 2 nike, 3 target, 4 walmart, 9 salvotest
        uint8   mode;              // 1 Lit reads the balance before opening, 2 blind
        uint40  listingExpiry;     // unix seconds
        bytes32 salt;              // 32 random bytes from the seller's browser
    }
    struct Ticket {
        bytes32 replyKeyHash;      // keccak256 of the shopper's 33-byte compressed secp256k1 reply key
        uint32  openBalanceCents;  // readable: the balance Lit read; blind: 0
        bytes32 cardTag;           // keyed fingerprint of the card, computed inside Lit
        uint40  notAfter;          // last second the ticket is valid
        bytes   signature;         // 65 bytes r||s||v, low s, v in {27,28}
    }
    struct Listing { address seller; uint8 state; uint40 createdAt; }
    struct Deposit {
        address depositor; uint40 openedAt; uint40 releaseAt; uint8 state; bool disputed; // slot 0
        address seller; uint96 amount;                                                     // slot 1
        bytes32 listingId;                                                                 // slot 2
        bytes32 replyKeyHash;                                                              // slot 3
        bytes32 cardTag;                                                                   // slot 4
    }
    /// paidOut: token units release() has paid this seller, summed. The blind cap grows with it.
    struct SellerStats { uint32 sold; uint32 disputes; uint32 refunds; uint96 paidOut; }

    // ------------------------------------------------------------------ constants
    string  public constant VERSION = "salvo-escrow/1";
    uint8   public constant MODE_READABLE = 1;
    uint8   public constant MODE_BLIND = 2;
    uint8   public constant LISTING_ACTIVE = 1;
    uint8   public constant LISTING_SOLD = 2;
    uint8   public constant LISTING_CANCELLED = 3;
    uint8   public constant DEPOSIT_OPENED = 1;
    uint8   public constant DEPOSIT_RELEASED = 2;
    uint8   public constant DEPOSIT_REFUNDED = 3;

    uint256 public constant UNITS_PER_CENT = 10_000;          // 6-decimal token, checked in the constructor
    uint256 public constant RELEASE_DELAY = 24 hours;
    uint256 public constant DISPUTE_HOLD = 48 hours;
    uint256 public constant MAX_TICKET_TTL = 15 minutes;
    uint256 public constant MAX_VALUE_CENTS = 50_000;         // $500
    uint256 public constant MAX_RESIDUAL_CAP_CENTS = 1_000;   // $10
    /// A blind card above this needs at least its value already paid out to its seller.
    uint256 public constant NEW_SELLER_BLIND_CAP_CENTS = 2_500; // $25

    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "SalvoTerms(uint256 chainId,address escrow,address token,address seller,uint96 price,uint32 valueCents,uint16 residualCapCents,uint8 merchant,uint8 mode,uint40 listingExpiry,bytes32 salt)");
    bytes32 public constant LISTING_TYPEHASH = keccak256("SalvoListing(bytes32 coreHash,bytes32 envelopeHash)");
    bytes32 public constant OPEN_TYPEHASH = keccak256(
        "Open(bytes32 listingId,address depositor,bytes32 replyKeyHash,uint32 openBalanceCents,bytes32 cardTag,uint40 notAfter)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("SalvoEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
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
    mapping(address => SellerStats) public sellerStats;
    mapping(address => uint256) public owed;           // payouts a recipient's token policy refused

    // ------------------------------------------------------------------ events
    event Listed(bytes32 indexed listingId, address indexed seller, bytes32 commitment);
    event ListingCancelled(bytes32 indexed listingId);
    event Opened(uint256 indexed depositId, bytes32 indexed listingId, address indexed depositor,
                 bytes32 cardTag, uint32 openBalanceCents, uint40 releaseAt);
    event Disputed(uint256 indexed depositId, bytes32 reasonHash, uint40 releaseAt);
    event Rekeyed(uint256 indexed depositId, bytes32 replyKeyHash);
    event Released(uint256 indexed depositId, uint256 amount);
    /// Emitted for every refund, part or full. `remaining` is what the deposit still holds for the
    /// seller. Only remaining == 0 closes the deposit; a part refund leaves it Opened and a
    /// Released event for the same id can follow. Read the state from getDeposit(id).state, never
    /// from the event's name.
    event Refunded(uint256 indexed depositId, uint256 toDepositor, uint256 remaining);
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

    /// Only while unsold.
    function cancelListing(bytes32 listingId) external {
        Listing storage l = _listings[listingId];
        require(l.seller == msg.sender, "not seller");
        require(l.state == LISTING_ACTIVE, "not active");
        l.state = LISTING_CANCELLED;
        emit ListingCancelled(listingId);
    }

    /// The only way money goes back to a shopper. Root passkey only (never in an access-key scope).
    /// Only the shopper's share moves now; nothing is paid to the seller early. A part refund
    /// leaves the deposit Opened, so the card still releases to the shopper, a dispute still holds
    /// the payout, and the rest goes to the seller on the usual schedule. Otherwise a seller could
    /// refund 1 unit the moment a sale lands: paid at once, with the card shut to its buyer.
    /// Refunding everything left closes the deposit and gives the card back to the seller.
    function sellerRefund(uint256 id, uint96 refundAmount) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(msg.sender == d.seller, "not seller");
        require(d.state == DEPOSIT_OPENED, "state");
        require(refundAmount > 0 && refundAmount <= d.amount, "amount");
        uint96 remaining = d.amount - refundAmount;
        d.amount = remaining;
        sellerStats[d.seller].refunds += 1;
        if (remaining == 0) {
            d.state = DEPOSIT_REFUNDED;
            // The sale is undone, so the card is the seller's to sell again. While this deposit is
            // Opened its buyer cannot resell the card (_checkTicket), so it is still this
            // purchase's; the check only keeps that true if anything ever changes.
            if (cardDeposit[d.cardTag] == id) {
                cardOwner[d.cardTag] = d.seller;
                cardDeposit[d.cardTag] = 0;
            }
        }
        emit Refunded(id, refundAmount, remaining);
        _pay(d.depositor, refundAmount);
    }

    // ------------------------------------------------------------------ shopper
    /// Pay and open in one step. Valid only with a litSigner ticket naming msg.sender.
    function depositAndOpen(Terms calldata t, bytes32 envelopeHash, Ticket calldata k)
        external nonReentrant returns (uint256 id)
    {
        bytes32 listingId = _checkTerms(t, envelopeHash);
        _checkTicket(t, listingId, k);
        id = _record(t, listingId, k);
        _pull(msg.sender, t.price);                               // effects above, transfer last
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
    /// After releaseAt: the seller is paid. Anyone may call; it pays only the seller.
    function release(uint256 id) external nonReentrant {
        Deposit storage d = _deposits[id];
        require(d.state == DEPOSIT_OPENED, "state");
        require(block.timestamp >= d.releaseAt, "too early");
        d.state = DEPOSIT_RELEASED;
        SellerStats storage s = sellerStats[d.seller];
        s.sold += 1;
        s.paidOut += d.amount;
        emit Released(id, d.amount);
        _pay(d.seller, d.amount);
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
    /// Everything the Lit template checks, in ONE eth_call (8 static words).
    function gate(bytes32 listingId, uint256 depositId) external view returns (
        address signer, address tokenAddress, address listingSeller, uint8 listingState,
        uint8 depositState, bytes32 depositListingId, bytes32 replyKeyHash, address depositor)
    {
        Listing storage l = _listings[listingId];
        Deposit storage d = _deposits[depositId];
        return (litSigner, token, l.seller, l.state, d.state, d.listingId, d.replyKeyHash, d.depositor);
    }
    function getListing(bytes32 listingId) external view returns (Listing memory) { return _listings[listingId]; }
    function getDeposit(uint256 id) external view returns (Deposit memory) { return _deposits[id]; }

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
    function openDigest(bytes32 listingId, address depositor, bytes32 replyKeyHash, uint32 openBalanceCents,
                        bytes32 cardTag, uint40 notAfter) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            OPEN_TYPEHASH, listingId, depositor, replyKeyHash, openBalanceCents, cardTag, notAfter));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------ internals
    function _checkTerms(Terms calldata t, bytes32 envelopeHash) private view returns (bytes32 listingId) {
        require(t.mode == MODE_READABLE || t.mode == MODE_BLIND, "mode");
        require(t.valueCents > 0 && t.valueCents <= MAX_VALUE_CENTS, "value");
        require(t.price > 0 && uint256(t.price) <= uint256(t.valueCents) * UNITS_PER_CENT, "price");
        require(t.residualCapCents <= MAX_RESIDUAL_CAP_CENTS, "cap");
        require(block.timestamp < t.listingExpiry, "listing expired");
        require(msg.sender != t.seller, "own listing");
        // Nobody can check a blind card before the sale, so its size is bounded by money, not by
        // a count of sales: a count is cheap to farm with 1-unit sales to a second address. A
        // blind card above $25 needs its seller already paid at least its value. Self-dealing
        // still counts, but then every dollar of cap costs a real dollar locked for RELEASE_DELAY.
        if (t.mode == MODE_BLIND && t.valueCents > NEW_SELLER_BLIND_CAP_CENTS) {
            require(uint256(sellerStats[t.seller].paidOut) >= uint256(t.valueCents) * UNITS_PER_CENT, "new seller cap");
        }
        listingId = listingIdOf(t.seller, commitmentOf(t, envelopeHash));
        require(_listings[listingId].state == LISTING_ACTIVE, "listing not active");
    }

    function _checkTicket(Terms calldata t, bytes32 listingId, Ticket calldata k) private view {
        require(k.replyKeyHash != bytes32(0), "reply key");
        require(k.cardTag != bytes32(0), "card tag");
        address current = cardOwner[k.cardTag];
        require(current == address(0) || current == t.seller, "card not seller's");
        // A buyer may resell a card only once their own purchase of it is paid out. Until then its
        // seller may still refund it, which hands the card back, so it is not the buyer's to sell.
        uint256 boughtIn = cardDeposit[k.cardTag];
        require(boughtIn == 0 || _deposits[boughtIn].state == DEPOSIT_RELEASED, "card not paid out");
        require(block.timestamp <= k.notAfter && uint256(k.notAfter) <= block.timestamp + MAX_TICKET_TTL, "ticket time");
        if (t.mode == MODE_READABLE) {
            require(k.openBalanceCents >= t.valueCents && k.openBalanceCents - t.valueCents <= t.residualCapCents, "balance");
        } else {
            require(k.openBalanceCents == 0, "blind balance");
        }
        bytes32 digest = openDigest(listingId, msg.sender, k.replyKeyHash, k.openBalanceCents, k.cardTag, k.notAfter);
        require(_recover(digest, k.signature) == litSigner, "not lit");
    }

    function _record(Terms calldata t, bytes32 listingId, Ticket calldata k) private returns (uint256 id) {
        id = ++depositCount;
        uint40 releaseAt = uint40(block.timestamp + RELEASE_DELAY);
        _deposits[id] = Deposit({
            depositor: msg.sender, openedAt: uint40(block.timestamp), releaseAt: releaseAt,
            state: DEPOSIT_OPENED, disputed: false, seller: t.seller, amount: t.price,
            listingId: listingId, replyKeyHash: k.replyKeyHash, cardTag: k.cardTag
        });
        _listings[listingId].state = LISTING_SOLD;
        cardOwner[k.cardTag] = msg.sender;
        cardDeposit[k.cardTag] = id;
        emit Opened(id, listingId, msg.sender, k.cardTag, k.openBalanceCents, releaseAt);
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
