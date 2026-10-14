/**
 * Presets supply the ABI for common standards so configs don't need ABI files.
 * They never add checks: every expectation in a config is written by its author.
 */

import type { PresetName } from '../config/schema';

export interface Preset {
  description: string;
  abi: string[];
}

const ERC20 = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export const PRESETS: Record<PresetName, Preset> = {
  erc20: {
    description: 'ERC-20 token: name, symbol, decimals, totalSupply, balanceOf, allowance',
    abi: ERC20,
  },
  erc721: {
    description: 'ERC-721 NFT: name, symbol, totalSupply, balanceOf, ownerOf, tokenURI, approvals',
    abi: [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)',
      'function ownerOf(uint256 tokenId) view returns (address)',
      'function tokenURI(uint256 tokenId) view returns (string)',
      'function getApproved(uint256 tokenId) view returns (address)',
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
      'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    ],
  },
  erc1155: {
    description: 'ERC-1155 multi-token: balanceOf, balanceOfBatch, uri, isApprovedForAll',
    abi: [
      'function balanceOf(address account, uint256 id) view returns (uint256)',
      'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
      'function uri(uint256 id) view returns (string)',
      'function isApprovedForAll(address account, address operator) view returns (bool)',
      'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    ],
  },
  erc4626: {
    description: 'ERC-4626 vault: ERC-20 plus asset, totalAssets, conversions and limits',
    abi: [
      ...ERC20,
      'function asset() view returns (address)',
      'function totalAssets() view returns (uint256)',
      'function convertToShares(uint256 assets) view returns (uint256)',
      'function convertToAssets(uint256 shares) view returns (uint256)',
      'function maxDeposit(address receiver) view returns (uint256)',
      'function maxMint(address receiver) view returns (uint256)',
      'function maxWithdraw(address owner) view returns (uint256)',
      'function maxRedeem(address owner) view returns (uint256)',
      'function previewDeposit(uint256 assets) view returns (uint256)',
      'function previewMint(uint256 shares) view returns (uint256)',
      'function previewWithdraw(uint256 assets) view returns (uint256)',
      'function previewRedeem(uint256 shares) view returns (uint256)',
    ],
  },
  diamond: {
    description: 'EIP-2535 diamond loupe: facets, facetAddresses, facetAddress, facetFunctionSelectors',
    abi: [
      'function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])',
      'function facetFunctionSelectors(address facet) view returns (bytes4[])',
      'function facetAddresses() view returns (address[])',
      'function facetAddress(bytes4 functionSelector) view returns (address)',
      'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    ],
  },
  proxy: {
    description:
      'Proxy helpers: implementation (beacons), proxiableUUID (UUPS). Use the proxy check for ERC-1967 slots.',
    abi: ['function implementation() view returns (address)', 'function proxiableUUID() view returns (bytes32)'],
  },
  accessControl: {
    description: 'OpenZeppelin AccessControl(Enumerable): hasRole, getRoleAdmin, member enumeration',
    abi: [
      'function hasRole(bytes32 role, address account) view returns (bool)',
      'function getRoleAdmin(bytes32 role) view returns (bytes32)',
      'function getRoleMemberCount(bytes32 role) view returns (uint256)',
      'function getRoleMember(bytes32 role, uint256 index) view returns (address)',
    ],
  },
};
