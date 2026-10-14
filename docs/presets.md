# Presets

A preset adds the ABI of a standard interface to a contract, so its functions can be called by name without an ABI file. Presets never add checks: every expectation in a config is one you wrote.

```yaml
contracts:
  USDC:
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    preset: erc20
    state:
      - type: variable
        name: symbol
        value: USDC
      - type: variable
        name: decimals
        value: 6
```

`nodrift presets` lists the presets with a short description.

## Available presets

### erc20

ERC-20 tokens.

| Function                                    | Returns   |
| ------------------------------------------- | --------- |
| `name()`                                    | `string`  |
| `symbol()`                                  | `string`  |
| `decimals()`                                | `uint8`   |
| `totalSupply()`                             | `uint256` |
| `balanceOf(address account)`                | `uint256` |
| `allowance(address owner, address spender)` | `uint256` |

### erc721

ERC-721 tokens.

| Function                                            | Returns   |
| --------------------------------------------------- | --------- |
| `name()`                                            | `string`  |
| `symbol()`                                          | `string`  |
| `totalSupply()`                                     | `uint256` |
| `balanceOf(address owner)`                          | `uint256` |
| `ownerOf(uint256 tokenId)`                          | `address` |
| `tokenURI(uint256 tokenId)`                         | `string`  |
| `getApproved(uint256 tokenId)`                      | `address` |
| `isApprovedForAll(address owner, address operator)` | `bool`    |
| `supportsInterface(bytes4 interfaceId)`             | `bool`    |

### erc1155

ERC-1155 multi-tokens.

| Function                                              | Returns     |
| ----------------------------------------------------- | ----------- |
| `balanceOf(address account, uint256 id)`              | `uint256`   |
| `balanceOfBatch(address[] accounts, uint256[] ids)`   | `uint256[]` |
| `uri(uint256 id)`                                     | `string`    |
| `isApprovedForAll(address account, address operator)` | `bool`      |
| `supportsInterface(bytes4 interfaceId)`               | `bool`      |

### erc4626

ERC-4626 vaults: every `erc20` function, plus:

| Function                          | Returns   |
| --------------------------------- | --------- |
| `asset()`                         | `address` |
| `totalAssets()`                   | `uint256` |
| `convertToShares(uint256 assets)` | `uint256` |
| `convertToAssets(uint256 shares)` | `uint256` |
| `maxDeposit(address receiver)`    | `uint256` |
| `maxMint(address receiver)`       | `uint256` |
| `maxWithdraw(address owner)`      | `uint256` |
| `maxRedeem(address owner)`        | `uint256` |
| `previewDeposit(uint256 assets)`  | `uint256` |
| `previewMint(uint256 shares)`     | `uint256` |
| `previewWithdraw(uint256 assets)` | `uint256` |
| `previewRedeem(uint256 shares)`   | `uint256` |

### diamond

The EIP-2535 diamond loupe.

| Function                                | Returns                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `facets()`                              | `(address facetAddress, bytes4[] functionSelectors)[]` |
| `facetFunctionSelectors(address facet)` | `bytes4[]`                                             |
| `facetAddresses()`                      | `address[]`                                            |
| `facetAddress(bytes4 functionSelector)` | `address`                                              |
| `supportsInterface(bytes4 interfaceId)` | `bool`                                                 |

### proxy

Helpers for proxies. The ERC-1967 slots themselves are checked with the [`proxy` check type](state-types.md#proxy), which needs no preset.

| Function           | Returns                                           |
| ------------------ | ------------------------------------------------- |
| `implementation()` | `address`, as exposed by beacons and some proxies |
| `proxiableUUID()`  | `bytes32`, as exposed by UUPS implementations     |

### accessControl

OpenZeppelin `AccessControl` and `AccessControlEnumerable`. The [`role` check type](state-types.md#role) has these functions built in; the preset is for calling them directly, for example `getRoleAdmin`.

| Function                                     | Returns   |
| -------------------------------------------- | --------- |
| `hasRole(bytes32 role, address account)`     | `bool`    |
| `getRoleAdmin(bytes32 role)`                 | `bytes32` |
| `getRoleMemberCount(bytes32 role)`           | `uint256` |
| `getRoleMember(bytes32 role, uint256 index)` | `address` |

## Examples

A diamond whose facets and routing should not change unnoticed, and a role hierarchy that should stay intact:

```yaml
contracts:
  Diamond:
    address: '0xB8A00Df65eD2E589a6be0153f8a5463705C03dAB'
    preset: diamond
    state:
      - type: array_state
        function: facetAddresses
        checks:
          length: 3
          contains:
            - '0x933Aae3a96433Bf517510DC164C1ed242314E110'
      - type: function_call
        function: facetAddress
        args: ['0xa9059cbb']
        value: '0x933Aae3a96433Bf517510DC164C1ed242314E110'

  Token:
    address: '0x5BBC840D4AbA89d7882E9c333e52E822b61232fd'
    preset: accessControl
    state:
      - type: function_call
        id: minter-admin
        function: getRoleAdmin
        args: ['0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6']
        value: '0x0000000000000000000000000000000000000000000000000000000000000000'
```

Function arguments are passed as they are. `facetAddress` takes a function selector, here `0xa9059cbb` for `transfer(address,uint256)`. Unlike the `role` check, `getRoleAdmin` takes the role's 32-byte hash, here `keccak256("MINTER_ROLE")`; the expected value is the zero hash, `DEFAULT_ADMIN_ROLE`.

## Presets and your own ABI

A contract can have a `preset` and an `abi` at the same time; nodrift combines them. If both declare a function with the same signature, the contract's own declaration is used. Some contracts deviate from the standard their preset describes, for example tokens whose `name()` and `symbol()` return `bytes32`. Declare those functions in `abi`, or write an inline signature in the check, which takes precedence over any ABI:

```yaml
- type: variable
  name: 'symbol() returns (bytes32)'
  value: '0x4d4b520000000000000000000000000000000000000000000000000000000000'
```

`owner`, `role`, `storage_slot` and `proxy` checks need no preset and no ABI.
