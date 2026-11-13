// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title MockToken (tests only; never deployed anywhere real)
/// @notice A small ERC-20 standing in for pathUSD in tests/escrow-contract.test.ts. Each toggle
///   reproduces a token behaviour SalvoEscrowV1 must survive:
///   - noReturn: transfer and transferFrom return no data, like old USDT.
///   - feeBps: the recipient receives less than was sent, so the escrow's exact-delta pull refuses it.
///   - hook: after moving balances, the token calls one address once with fixed data (a reentrant
///     callback), records whether that call succeeded, and never bubbles its failure.
///   - blocked: a per-recipient refusal, like a TIP-20 transfer policy. Mode 1 reverts, mode 2
///     returns false. Either one must turn a payout into `owed` without stranding the other party.
contract MockToken {
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public constant FEE_SINK = address(uint160(0xFEE));
    uint8 public constant BLOCK_REVERT = 1;
    uint8 public constant BLOCK_RETURN_FALSE = 2;

    bool public noReturn;
    uint256 public feeBps;
    mapping(address => uint8) public blocked;

    address public hookTarget;
    bytes public hookData;
    bool public hookArmed;
    bool public hookCalled;
    bool public hookOk;
    bytes public hookReturn;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    // ------------------------------------------------------------------ test controls
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setNoReturn(bool on) external { noReturn = on; }

    function setFeeBps(uint256 bps) external {
        require(bps <= 10_000, "bps");
        feeBps = bps;
    }

    function setBlocked(address who, uint8 mode) external {
        require(mode <= BLOCK_RETURN_FALSE, "mode");
        blocked[who] = mode;
    }

    /// Arms a one-shot callback: the next transfer (or transferFrom) calls `target` with `data`.
    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
        hookArmed = target != address(0);
        hookCalled = false;
        hookOk = false;
        delete hookReturn;
    }

    // ------------------------------------------------------------------ ERC-20
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (!_move(msg.sender, to, amount)) return false;
        _finish();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        if (!_move(from, to, amount)) return false;
        _finish();
        return true;
    }

    // ------------------------------------------------------------------ internals
    function _move(address from, address to, uint256 amount) private returns (bool) {
        uint8 b = blocked[to];
        require(b != BLOCK_REVERT, "blocked");
        if (b == BLOCK_RETURN_FALSE) return false;
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount * feeBps / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        emit Transfer(from, to, amount - fee);
        if (fee > 0) {
            balanceOf[FEE_SINK] += fee;
            emit Transfer(from, FEE_SINK, fee);
        }
        if (hookArmed) {
            hookArmed = false;
            hookCalled = true;
            (bool ok, bytes memory ret) = hookTarget.call(hookData);
            hookOk = ok;
            hookReturn = ret;
        }
        return true;
    }

    /// A successful move either returns true normally or, with noReturn on, ends the call with no data.
    function _finish() private view {
        if (noReturn) {
            assembly { return(0, 0) }
        }
    }
}
