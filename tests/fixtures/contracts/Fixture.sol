// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test contract with a known storage layout. The e2e suite mutates it to create drift.
contract Fixture {
    // slot 0: owner (low 20 bytes) packed with flags (high 12 bytes)
    address public owner;
    uint96 public flags;
    // slot 1
    uint256 public totalSupply;
    // slot 2
    mapping(address => uint256) public balanceOf;
    // slot 3
    mapping(address => mapping(address => uint256)) public allowance;
    // slot 4
    bool public paused;
    // slot 5
    uint256 public lastUpdate;

    string public symbol = "FIX";
    address[] internal _members;
    mapping(bytes32 => mapping(address => bool)) internal _roles;
    mapping(bytes32 => address[]) internal _roleMembers;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error NotAllowed(address caller);

    constructor(address implementation) {
        owner = 0x1111111111111111111111111111111111111111;
        flags = 1;
        totalSupply = 1_000_000 ether + 1_000_000;
        balanceOf[0x000000000000000000000000000000000000dEaD] = 100;
        balanceOf[0x00000000000000000000000000000000DeaDBeef] = 200;
        allowance[0x000000000000000000000000000000000000dEaD][0x00000000000000000000000000000000DeaDBeef] = 5;
        lastUpdate = block.timestamp;
        _members.push(0x000000000000000000000000000000000000dEaD);
        _members.push(0x00000000000000000000000000000000DeaDBeef);
        _grant(bytes32(0), 0x1111111111111111111111111111111111111111);
        _grant(MINTER_ROLE, 0x2222222222222222222222222222222222222222);
        _grant(MINTER_ROLE, 0x3333333333333333333333333333333333333333);
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, implementation)
        }
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function getRoleMemberCount(bytes32 role) external view returns (uint256) {
        return _roleMembers[role].length;
    }

    function getRoleMember(bytes32 role, uint256 index) external view returns (address) {
        return _roleMembers[role][index];
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (7, 2000e8, lastUpdate, lastUpdate, 7);
    }

    function guarded() external view returns (uint256) {
        revert NotAllowed(msg.sender);
    }

    function failing() external pure returns (uint256) {
        revert("always fails");
    }

    function setFlags(uint96 value) external {
        flags = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setBalance(address account, uint256 value) external {
        balanceOf[account] = value;
    }

    function setLastUpdate(uint256 value) external {
        lastUpdate = value;
    }

    function grant(bytes32 role, address account) external {
        _grant(role, account);
    }

    function _grant(bytes32 role, address account) internal {
        _roles[role][account] = true;
        _roleMembers[role].push(account);
    }
}

/// BEP-20 style ownership (getOwner) and AccessControl without enumeration.
contract Legacy {
    function getOwner() external pure returns (address) {
        return 0x1111111111111111111111111111111111111111;
    }

    function hasRole(bytes32, address) external pure returns (bool) {
        return false;
    }
}

/// ABI-compatible subset of Multicall3, installed at the canonical address in tests.
contract Multicall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(success, ret);
        }
    }
}
