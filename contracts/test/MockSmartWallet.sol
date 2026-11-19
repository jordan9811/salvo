// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title MockSmartWallet (tests only; never deployed anywhere real)
/// @notice A buyer whose address has code, as a smart wallet or an EIP-7702 account has. Real
///   USDC asks such a buyer's code whether a signature is good (EIP-1271) instead of running
///   ECDSA, so tests/salvo-orders-contract.test.ts pays from one of these to prove the order
///   escrow works for it.
///   isValidSignature accepts, for its one owner key:
///   - 65 bytes: a plain r,s,v signature over the digest (what an EIP-7702 account's delegate
///     commonly accepts);
///   - 97 bytes: WRAP_TAG then the 65 bytes, standing in for a smart wallet's longer signature,
///     which only fits the escrow's bytes form, never v, r, s.
contract MockSmartWallet {
    address public immutable owner;
    bytes32 public constant WRAP_TAG = keccak256("MockSmartWallet wrapped signature");
    bytes4 private constant MAGIC = 0x1626ba7e;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        bytes calldata ecdsa = signature;
        if (signature.length == 97) {
            if (bytes32(signature[0:32]) != WRAP_TAG) return 0xffffffff;
            ecdsa = signature[32:97];
        } else if (signature.length != 65) {
            return 0xffffffff;
        }
        address a = ecrecover(digest, uint8(ecdsa[64]), bytes32(ecdsa[0:32]), bytes32(ecdsa[32:64]));
        return a != address(0) && a == owner ? MAGIC : bytes4(0xffffffff);
    }
}
