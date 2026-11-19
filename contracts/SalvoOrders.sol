// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title SalvoOrders ("salvo-orders/1")
/// @notice An agent's order, paid once. The agent puts the order's whole price in here; Salvo's
///   runner then buys the cards on SalvoEscrowV2 from its own float and does the checkout. The
///   money leaves on ONE of two roads:
///   - `settle`, with the runner's signature over the result: `refund` to the buyer and the rest
///     to `payout`. A failed order is a settle with refund == amount.
///   - `reclaim`, after the deadline, while nothing has settled: the whole amount to the buyer.
///     It needs nothing from Salvo, so the agent can always get out.
///
///   Ways in. `open` pulls an approved amount from msg.sender (Tempo's pathUSD, or any ERC-20).
///   `openWithAuthorization` takes a USDC EIP-3009 authorization that anyone may relay; the
///   authorization's nonce IS the order's parameters hashed, so the relayer cannot change the
///   terms, the amount or the deadline, and the token's own burnt nonce stops a replay.
///   `openWithAuthorizationSignature` is the same with the signature as bytes, for a buyer whose
///   address has code (a smart wallet, or an EIP-7702 account): USDC asks that code through
///   EIP-1271, and such a signature need not be 65 bytes.
///
/// @dev No owner, admin, fee, pause, upgrade, delegatecall or selfdestruct. token, runner and
///   payout are immutable, so they live in the runtime code: a pin on the deployed code hash
///   covers them too. src/lib/agent/orders/artifact.ts rebuilds that code for given arguments.
///
///   MONEY LEAVES ONLY TO: an order's buyer (a refund, a reclaim); `payout` (a settled order's
///   share); or an `owed` claimant.
///   Invariant: token balance == every OPEN order's amount + every owed.
///
///   The deadline is the opener's to choose. The contract cannot know how long a run takes, so
///   the runner must check the order's deadline against the quote and its own time budget before
///   it buys anything: once the deadline passes anyone may reclaim, and a later settle is refused.
contract SalvoOrders {
    // ------------------------------------------------------------------ types
    struct Order {
        address buyer;               // who paid, and who every refund goes to
        uint96  amount;              // token base units (6 decimals)
        uint40  deadline;            // unix seconds; after it the buyer may reclaim
        uint8   state;               // ORDER_OPEN, ORDER_SETTLED, ORDER_RECLAIMED
        bytes32 termsHash;           // keccak256 of the order's canonical terms (off chain)
    }

    // ------------------------------------------------------------------ constants
    string  public constant VERSION = "salvo-orders/1";
    uint8   public constant ORDER_OPEN = 1;
    uint8   public constant ORDER_SETTLED = 2;
    uint8   public constant ORDER_RECLAIMED = 3;
    /// The longest an order may hold the buyer's money before they can take it back.
    uint256 public constant MAX_DURATION = 30 days;

    /// The whole order is in the signed message, not only its id. Ids are handed out in
    /// transaction order and a reorg can give an id to someone else's order; a signature that
    /// names the buyer, amount, deadline and terms settles only the order it was made for.
    bytes32 public constant SETTLE_TYPEHASH = keccak256(
        "Settle(uint256 id,address buyer,uint96 amount,uint40 deadline,bytes32 termsHash,bytes32 resultHash,uint96 refund)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("SalvoOrders");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    /// receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
    bytes4 private constant RECEIVE_WITH_AUTHORIZATION = 0xef55bec6;
    /// receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes), FiatToken v2.2
    bytes4 private constant RECEIVE_WITH_AUTHORIZATION_BYTES = 0x88b7ab63;

    // ------------------------------------------------------------------ immutables (in the code)
    address public immutable token;
    address public immutable runner;   // the only key whose signature settles an order
    address public immutable payout;   // where a settled order's share goes

    // ------------------------------------------------------------------ storage
    uint256 public orderCount;
    uint256 private _lock = 1;
    mapping(uint256 => Order) private _orders;
    mapping(address => uint256) public owed;           // payouts a recipient's token policy refused

    // ------------------------------------------------------------------ events
    /// buyer and termsHash are indexed so a relayer whose own submission lost the race to a copy
    /// of it can find the order that did open with one exact log filter.
    event Opened(uint256 indexed id, address indexed buyer, uint96 amount, uint40 deadline, bytes32 indexed termsHash);
    event Settled(uint256 indexed id, bytes32 resultHash, uint96 refund);
    event Reclaimed(uint256 indexed id);
    event Owed(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);

    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }

    constructor(address token_, address runner_, address payout_) {
        require(token_.code.length > 0, "token");                 // TIP-20 precompile code is 0xef (length 1)
        (bool ok, bytes memory ret) = token_.staticcall(abi.encodeWithSelector(0x313ce567));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) == 6, "decimals");
        require(runner_ != address(0), "runner");
        require(payout_ != address(0), "payout");
        token = token_;
        runner = runner_;
        payout = payout_;
    }

    // ------------------------------------------------------------------ buyer
    /// Pay `amount` from msg.sender (approved beforehand) into a new order.
    function open(bytes32 termsHash, uint96 amount, uint40 deadline) external nonReentrant returns (uint256 id) {
        id = _record(msg.sender, termsHash, amount, deadline);
        _pull(msg.sender, amount);
    }

    /// Open an order for `buyer` with their USDC EIP-3009 authorization. Anyone may submit it.
    /// The token checks the signature and that this contract is the payee; this checks that the
    /// signed nonce is the order's own parameters, which is what binds them to the buyer.
    function openWithAuthorization(
        address buyer, bytes32 termsHash, uint96 amount, uint40 deadline,
        uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external nonReentrant returns (uint256 id) {
        bytes memory tokenCall = abi.encodeWithSelector(
            RECEIVE_WITH_AUTHORIZATION, buyer, address(this), uint256(amount), validAfter, validBefore, nonce, v, r, s);
        id = _openAuthorized(buyer, termsHash, amount, deadline, nonce, tokenCall);
    }

    /// The same with the signature as bytes. USDC checks it by EIP-1271 when the buyer's address
    /// has code, and as a 65-byte r,s,v ECDSA signature when it has none.
    function openWithAuthorizationSignature(
        address buyer, bytes32 termsHash, uint96 amount, uint40 deadline,
        uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature
    ) external nonReentrant returns (uint256 id) {
        bytes memory tokenCall = abi.encodeWithSelector(
            RECEIVE_WITH_AUTHORIZATION_BYTES, buyer, address(this), uint256(amount), validAfter, validBefore, nonce, signature);
        id = _openAuthorized(buyer, termsHash, amount, deadline, nonce, tokenCall);
    }

    // ------------------------------------------------------------------ settle and reclaim
    /// Pay out an open order on the runner's signed result. Anyone may submit the signature.
    /// Allowed after the deadline too, until someone reclaims.
    function settle(uint256 id, bytes32 resultHash, uint96 refund, bytes calldata signature) external nonReentrant {
        Order storage o = _orders[id];
        require(o.state == ORDER_OPEN, "not open");
        uint96 amount = o.amount;
        require(refund <= amount, "refund");
        require(_recover(settleDigest(id, resultHash, refund), signature) == runner, "signer");
        o.state = ORDER_SETTLED;
        emit Settled(id, resultHash, refund);
        _pay(o.buyer, refund);
        _pay(payout, amount - refund);
    }

    /// Past the deadline with nothing settled, the whole amount goes back to the buyer.
    /// Anyone may call it; the money only ever goes to the buyer.
    function reclaim(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        require(o.state == ORDER_OPEN, "not open");
        require(block.timestamp > o.deadline, "too early");
        o.state = ORDER_RECLAIMED;
        emit Reclaimed(id);
        _pay(o.buyer, o.amount);
    }

    /// Retry a payout the token refused earlier. Pays only `to`: a credit cannot be sent anywhere
    /// else, because a USDC blacklist is a freeze and routing around it is not this contract's call.
    function claim(address to) external nonReentrant {
        uint256 a = owed[to];
        require(a > 0, "nothing owed");
        owed[to] = 0;
        require(_tryTransfer(to, a), "transfer failed");
        emit Claimed(to, a);
    }

    // ------------------------------------------------------------------ views
    function getOrder(uint256 id) external view returns (Order memory) { return _orders[id]; }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// What the runner signs. The order's buyer, amount, deadline and termsHash are read from
    /// storage, so a signature made for one order never settles another, whatever id it lands at.
    function settleDigest(uint256 id, bytes32 resultHash, uint96 refund) public view returns (bytes32) {
        Order storage o = _orders[id];
        bytes32 structHash = keccak256(abi.encode(
            SETTLE_TYPEHASH, id, o.buyer, o.amount, o.deadline, o.termsHash, resultHash, refund));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// The EIP-3009 nonce an order's authorization must carry. The chain and this contract are in
    /// it, so an authorization made for one deployment opens nothing anywhere else.
    function authorizationNonce(address buyer, bytes32 termsHash, uint96 amount, uint40 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), buyer, termsHash, amount, deadline));
    }

    // ------------------------------------------------------------------ internals
    function _record(address buyer, bytes32 termsHash, uint96 amount, uint40 deadline) private returns (uint256 id) {
        require(amount > 0, "amount");
        require(termsHash != bytes32(0), "terms");
        require(block.timestamp < deadline && deadline <= block.timestamp + MAX_DURATION, "deadline");
        id = ++orderCount;
        _orders[id] = Order(buyer, amount, deadline, ORDER_OPEN, termsHash);
        emit Opened(id, buyer, amount, deadline, termsHash);
    }

    /// Both authorization forms: check the bound nonce, record the order, have the token move the
    /// money, and refuse anything but exactly `amount` arriving.
    function _openAuthorized(
        address buyer, bytes32 termsHash, uint96 amount, uint40 deadline, bytes32 nonce, bytes memory tokenCall
    ) private returns (uint256 id) {
        require(buyer != address(0), "buyer");
        require(nonce == authorizationNonce(buyer, termsHash, amount, deadline), "nonce");
        id = _record(buyer, termsHash, amount, deadline);
        uint256 before = _balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(tokenCall);
        if (!ok) {
            // The token's own reason (used nonce, bad signature, expired) says more than ours would.
            if (ret.length > 0) assembly { revert(add(ret, 32), mload(ret)) }
            revert("authorization");
        }
        require(_balanceOf(address(this)) - before == amount, "pull amount");   // refuses fee-on-transfer
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
        (bool ok, uint256 b) = _tryBalanceOf(account);
        require(ok, "balanceOf");
        return b;
    }

    function _pull(address from, uint256 amount) private {
        uint256 before = _balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        require(ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool)))), "pull");
        require(_balanceOf(address(this)) - before == amount, "pull amount");   // refuses fee-on-transfer
    }

    /// A blocked recipient never strands the other party: what did not leave becomes `owed`.
    /// After a refusal the balance is read again, so a token that moved the money and then said
    /// no is not paid a second time through `claim`, out of other orders' money. Neither read
    /// can stop a payout: if the balance cannot be read, the whole amount is owed, as in V2, so
    /// a reclaim still goes through and needs nothing but a working transfer.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool known, uint256 before) = _tryBalanceOf(address(this));
        if (_tryTransfer(to, amount)) return;
        uint256 moved;
        if (known) {
            (bool knownAfter, uint256 left) = _tryBalanceOf(address(this));
            if (knownAfter && before > left) moved = before - left;
        }
        if (moved >= amount) return;
        owed[to] += amount - moved;
        emit Owed(to, amount - moved);
    }

    function _tryBalanceOf(address account) private view returns (bool, uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || ret.length != 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }
}
