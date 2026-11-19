// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title MockUSDC (tests only; never deployed anywhere real)
/// @notice Stands in for Circle's FiatToken (USDC v2.2) in tests/salvo-orders-contract.test.ts.
///   What SalvoOrders relies on is copied from FiatToken, with its revert texts:
///   - EIP-712 domain {name, version "2", chainId, verifyingContract}; Base Sepolia's USDC is
///     named "USDC".
///   - receiveWithAuthorization, both forms: (v, r, s) and (bytes signature). The caller must be
///     the payee; validAfter < now < validBefore; a nonce is per authorizer and burns on use.
///     The signature is checked as v2.2's SignatureChecker does: when `from` has code it asks
///     that code by EIP-1271 isValidSignature and never looks at ECDSA; when it has none, it
///     runs ECRecover (65 bytes r,s,v, low s, v 27 or 28, no zero address). The (v, r, s) form
///     packs r,s,v into bytes and takes the same road, as v2.2 does.
///   - blacklisting: a blacklisted sender or payee makes transfer and receiveWithAuthorization
///     revert, which is how a real USDC payout to a buyer can fail.
///   - transfer and transferFrom return true; approve, allowance, decimals 6.
///   Not FiatToken, test controls only: `mint` by anyone; `feeBps`, a fee taken from what the
///   payee receives; a one-shot reentrant hook after a move; `setBalanceOfReverts`, a balanceOf
///   that fails; and `setSaysNoAfterMove`, a transfer to that payee that moves the money and
///   then returns false. Each gives the escrow something to refuse or survive.
contract MockUSDC {
    string public name;
    string public constant symbol = "USDC";
    string public constant version = "2";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlacklisted;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    address public constant FEE_SINK = address(uint160(0xFEE));
    uint256 public feeBps;
    bool public balanceOfReverts;
    mapping(address => bool) public saysNoAfterMove;

    address public hookTarget;
    bytes public hookData;
    bool public hookArmed;
    bool public hookCalled;
    bool public hookOk;
    bytes public hookReturn;

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    modifier notBlacklisted(address account) {
        require(!isBlacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    constructor(string memory name_) {
        name = name_;
    }

    // ------------------------------------------------------------------ test controls
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFeeBps(uint256 bps) external {
        require(bps <= 10_000, "bps");
        feeBps = bps;
    }

    function setBlacklisted(address who, bool on) external { isBlacklisted[who] = on; }

    function setBalanceOfReverts(bool on) external { balanceOfReverts = on; }

    function setSaysNoAfterMove(address who, bool on) external { saysNoAfterMove[who] = on; }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
        hookArmed = target != address(0);
        hookCalled = false;
        hookOk = false;
        delete hookReturn;
    }

    // ------------------------------------------------------------------ ERC-20
    function balanceOf(address account) external view returns (uint256) {
        require(!balanceOfReverts);
        return _balances[account];
    }

    function approve(address spender, uint256 value) external notBlacklisted(msg.sender) notBlacklisted(spender) returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external notBlacklisted(msg.sender) notBlacklisted(to) returns (bool) {
        _transfer(msg.sender, to, value);
        return !saysNoAfterMove[to];
    }

    function transferFrom(address from, address to, uint256 value)
        external notBlacklisted(msg.sender) notBlacklisted(from) notBlacklisted(to) returns (bool)
    {
        require(value <= allowance[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    // ------------------------------------------------------------------ EIP-3009
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external notBlacklisted(from) notBlacklisted(to) {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        bytes memory signature
    ) external notBlacklisted(from) notBlacklisted(to) {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        require(_isValidSignatureNow(authorizer, _digest(structHash), abi.encodePacked(r, s, v)), "FiatTokenV2: invalid signature");
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // ------------------------------------------------------------------ internals
    function _receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        bytes memory signature
    ) private {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 structHash = keccak256(abi.encode(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        require(_isValidSignatureNow(from, _digest(structHash), signature), "FiatTokenV2: invalid signature");
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR(), structHash));
    }

    /// FiatToken v2.2's SignatureChecker.isValidSignatureNow: code at the signer means EIP-1271
    /// only, no code means ECRecover only.
    function _isValidSignatureNow(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer.code.length == 0) return _recover(digest, signature) == signer;
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(ERC1271_MAGIC);
    }

    /// FiatToken's ECRecover.recover(bytes32, bytes), with its revert texts.
    function _recover(bytes32 digest, bytes memory signature) private pure returns (address a) {
        require(signature.length == 65, "ECRecover: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        require(uint256(s) <= HALF_N, "ECRecover: invalid signature 's' value");
        require(v == 27 || v == 28, "ECRecover: invalid signature 'v' value");
        a = ecrecover(digest, v, r, s);
        require(a != address(0), "ECRecover: invalid signature");
    }

    function _transfer(address from, address to, uint256 value) private {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(value <= _balances[from], "ERC20: transfer amount exceeds balance");
        uint256 fee = value * feeBps / 10_000;
        _balances[from] -= value;
        _balances[to] += value - fee;
        emit Transfer(from, to, value - fee);
        if (fee > 0) {
            _balances[FEE_SINK] += fee;
            emit Transfer(from, FEE_SINK, fee);
        }
        if (hookArmed) {
            hookArmed = false;
            hookCalled = true;
            (bool ok, bytes memory ret) = hookTarget.call(hookData);
            hookOk = ok;
            hookReturn = ret;
        }
    }
}
