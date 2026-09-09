import { ethers } from "ethers";
import type { AnchorRecord, Decision, Verdict, Address, Policy } from "./types.js";

/**
 * BOT Chain wiring for ChainShield.
 *
 * The production contract is a single on-chain registry:
 *   - every wallet can setPolicy(...) for itself
 *   - every user can recordDecision(...) to create an immutable audit record
 * This file handles wallet connection, network switching, contract reads,
 * and writes. The deterministic rule engine itself still runs client-side
 * so evaluations are instant and free.
 */

export const BOT_CHAIN_ID = 677;
export const BOT_CHAIN_ID_HEX = "0x2a5";
export const BOT_RPC = "https://rpc.botchain.ai/";
export const BOT_EXPLORER = "https://scan.botchain.ai";
export const CHAINSHIELD_CONTRACT = "0x0E62a1e1116084a7B20C1e8155BF5EaE4ed56849";

const CHAINSHIELD_ABI = [
  // reads
  "function name() view returns (string)",
  "function version() view returns (uint256)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function recordCount() view returns (uint256)",
  "function policies(address owner) view returns (bool active, uint256 maxTransfer, uint256 maxDailyOutflow, uint256 version, uint256 updatedAt, address[] allowedDestinations, bytes4[] forbiddenSelectors, address[] tokens)",
  "function getPolicy(address policyOwner) view returns ((bool active, uint256 maxTransfer, uint256 maxDailyOutflow, uint256 version, uint256 updatedAt, address[] allowedDestinations, bytes4[] forbiddenSelectors, address[] tokens) policy, uint256[] caps)",
  "function approvalCapByToken(address owner, address token) view returns (uint256)",
  "function records(bytes32 intentHash) view returns (uint8 verdict, uint256 riskScore, uint256 timestamp, address recorder)",
  // writes
  "function setPolicy((bool active, uint256 maxTransfer, uint256 maxDailyOutflow, address[] allowedDestinations, bytes4[] forbiddenSelectors, address[] tokens, uint256[] caps) input)",
  "function recordDecision(bytes32 intentHash, uint8 verdict, uint256 riskScore)",
  "function pause()",
  "function unpause()",
  // events
  "event DecisionRecorded(bytes32 indexed intentHash, address indexed recorder, uint8 verdict, uint256 riskScore, uint256 timestamp)",
  "event PolicySet(address indexed owner, uint256 maxTransfer, uint256 maxDailyOutflow, uint256 version, uint256 timestamp)",
  "event ContractPaused(address indexed account)",
  "event ContractUnpaused(address indexed account)",
];

const VERDICT_CODE: Record<Verdict, number> = {
  ALLOW: 0,
  REQUIRE_HUMAN_CONFIRMATION: 1,
  BLOCK: 2,
};

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (data: unknown) => void): void;
  removeListener?(event: string, listener: (data: unknown) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function explorerTxUrl(txHash: string): string {
  return `${BOT_EXPLORER}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${BOT_EXPLORER}/address/${address}`;
}

export function intentHashOf(d: Decision): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint256", "bytes", "uint256"],
    [d.intent.from, d.intent.to, BigInt(d.intent.value || "0"), d.intent.data || "0x", BigInt(d.intent.chainId)],
  );
  return ethers.keccak256(encoded);
}

async function getProvider(): Promise<ethers.BrowserProvider> {
  if (!window.ethereum) throw new Error("No injected wallet found. Install an EVM wallet to use ChainShield.");
  return new ethers.BrowserProvider(window.ethereum);
}

export async function getAccount(): Promise<string | null> {
  if (!window.ethereum) return null;
  const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
  return accounts[0] ?? null;
}

export async function getBalance(address: string): Promise<string> {
  const provider = await getProvider();
  const bal = await provider.getBalance(address);
  return ethers.formatEther(bal);
}

export async function connectWallet(): Promise<string> {
  if (!window.ethereum) throw new Error("No injected wallet found. Install an EVM wallet to use ChainShield.");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  await ensureBotChain(provider);
  const signer = await provider.getSigner();
  return signer.getAddress();
}

export async function ensureBotChain(provider?: ethers.BrowserProvider): Promise<void> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No injected wallet found.");
  const p = provider ?? (await getProvider());
  const network = await p.getNetwork();
  if (Number(network.chainId) === BOT_CHAIN_ID) return;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BOT_CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BOT_CHAIN_ID_HEX,
          chainName: "BOT Chain",
          rpcUrls: [BOT_RPC],
          nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
          blockExplorerUrls: [BOT_EXPLORER + "/"],
        },
      ],
    });
  }
}

export async function readChainShieldContract(): Promise<ethers.Contract> {
  const provider = await getProvider();
  return new ethers.Contract(CHAINSHIELD_CONTRACT, CHAINSHIELD_ABI, provider);
}

export async function writeChainShieldContract(): Promise<ethers.Contract> {
  const provider = new ethers.BrowserProvider(window.ethereum!);
  await ensureBotChain(provider);
  const signer = await provider.getSigner();
  return new ethers.Contract(CHAINSHIELD_CONTRACT, CHAINSHIELD_ABI, signer);
}

export interface OnChainPolicy {
  active: boolean;
  maxTransferEth: number;
  maxDailyOutflowEth: number;
  version: bigint;
  updatedAt: bigint;
  allowedDestinations: Address[];
  forbiddenSelectors: `0x${string}`[];
  approvalCapByToken: Partial<Record<Address, string>>;
}

export function formatEth(wei: bigint): number {
  return Number(ethers.formatEther(wei));
}

export async function loadOnChainPolicy(owner: string): Promise<OnChainPolicy | null> {
  const c = await readChainShieldContract();
  const [policy, caps] = await c.getPolicy(owner);
  if (!policy.active && policy.version === 0n) return null;
  const approvalCapByToken: Partial<Record<Address, string>> = {};
  for (let i = 0; i < policy.tokens.length; i++) {
    const token = policy.tokens[i].toLowerCase() as Address;
    approvalCapByToken[token] = caps[i].toString();
  }
  return {
    active: policy.active,
    maxTransferEth: formatEth(policy.maxTransfer),
    maxDailyOutflowEth: formatEth(policy.maxDailyOutflow),
    version: policy.version,
    updatedAt: policy.updatedAt,
    allowedDestinations: policy.allowedDestinations.map((a: string) => a.toLowerCase() as Address),
    forbiddenSelectors: policy.forbiddenSelectors.map((s: string) => s.toLowerCase() as `0x${string}`),
    approvalCapByToken,
  };
}

export interface PolicyInput {
  active: boolean;
  maxTransferEth: number;
  maxDailyOutflowEth: number;
  allowedDestinations: Address[];
  forbiddenSelectors: `0x${string}`[];
  approvalCapByToken: Partial<Record<Address, string>>;
}

export async function setOnChainPolicy(input: PolicyInput): Promise<`0x${string}`> {
  const c = await writeChainShieldContract();
  const tokens = Object.keys(input.approvalCapByToken);
  const caps = tokens.map((t) => BigInt(input.approvalCapByToken[t as Address] ?? "0"));
  const tx = await c.setPolicy({
    active: input.active,
    maxTransfer: ethers.parseEther(String(input.maxTransferEth)),
    maxDailyOutflow: ethers.parseEther(String(input.maxDailyOutflowEth)),
    allowedDestinations: input.allowedDestinations,
    forbiddenSelectors: input.forbiddenSelectors,
    tokens,
    caps,
  });
  const receipt = await tx.wait();
  return receipt.hash as `0x${string}`;
}

export async function recordDecisionOnChain(d: Decision): Promise<AnchorRecord> {
  const c = await writeChainShieldContract();
  const intentHash = intentHashOf(d);
  const tx = await c.recordDecision(intentHash, VERDICT_CODE[d.verdict], BigInt(d.riskScore));
  const receipt = await tx.wait();
  return { rootHash: intentHash, txHash: receipt.hash as string };
}

export interface OnChainRecord {
  intentHash: string;
  recorder: string;
  verdict: number;
  riskScore: bigint;
  timestamp: bigint;
}

export async function fetchRecentDecisions(limit = 20): Promise<OnChainRecord[]> {
  const c = await readChainShieldContract();
  const filter = c.filters.DecisionRecorded();
  const logs = await c.queryFilter(filter, -100000, "latest");
  const parsed = logs
    .slice(-limit)
    .reverse()
    .map((log: { args: { intentHash: string; recorder: string; verdict: number; riskScore: bigint; timestamp: bigint } }) => ({
      intentHash: log.args.intentHash,
      recorder: log.args.recorder,
      verdict: log.args.verdict,
      riskScore: log.args.riskScore,
      timestamp: log.args.timestamp,
    }));
  return parsed;
}

export async function fetchRecord(intentHash: string): Promise<OnChainRecord | null> {
  const c = await readChainShieldContract();
  const rec = await c.records(intentHash);
  if (rec.recorder === ethers.ZeroAddress) return null;
  return {
    intentHash,
    recorder: rec.recorder,
    verdict: rec.verdict,
    riskScore: rec.riskScore,
    timestamp: rec.timestamp,
  };
}
