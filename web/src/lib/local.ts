import { ethers } from "ethers";
import type {
  Address,
  ApiResult,
  Decision,
  Hex,
  Policy,
  PolicyRemediation,
  PolicyRules,
  TxIntent,
  Verdict,
} from "./types.js";

/**
 * Client-side replacement for the ChainShield risk-gate backend.
 *
 * The original stack proxied every call to a Fastify server which kept
 * policies and the decision timeline in memory (optionally anchoring on
 * external storage). On BOT Chain the same deterministic engine runs
 * entirely in the browser; decisions can optionally be recorded on-chain
 * via the ChainShieldAudit contract (see botchain.ts).
 */

const ERC20_APPROVE: Hex = "0x095ea7b3";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEI_PER_ETH = 10n ** 18n;

export const TREASURY: Address = "0x1111111111111111111111111111111111111111";
export const COLD_VAULT: Address = "0x2222222222222222222222222222222222222222";
export const ATTACKER: Address = "0x3333333333333333333333333333333333333333";
export const TOKEN: Address = "0x4444444444444444444444444444444444444444";

function selectorOf(data: Hex): Hex | null {
  if (!data || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase() as Hex;
}

function decodeUint256(data: Hex, paramIndex: number): bigint | null {
  const offset = 10 + paramIndex * 64;
  if (data.length < offset + 64) return null;
  try {
    return BigInt("0x" + data.slice(offset, offset + 64));
  } catch {
    return null;
  }
}

function weiToEthFloat(wei: bigint): number {
  const whole = wei / WEI_PER_ETH;
  const frac = wei % WEI_PER_ETH;
  return Number(whole) + Number(frac) / Number(WEI_PER_ETH);
}

function decimalStringOf(value: number): string {
  const str = value.toString();
  if (!str.toLowerCase().includes("e")) return str;
  const [mantissa = "0", exponentPart = "0"] = str.toLowerCase().split("e");
  const exponent = Number(exponentPart);
  const digits = mantissa.replace(".", "");
  const decimalPlaces = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
  const decimalIndex = digits.length - decimalPlaces + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function ethToWei(eth: number): bigint {
  const [whole, frac = ""] = decimalStringOf(eth).split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole ?? "0") * WEI_PER_ETH + BigInt(padded || "0");
}

function tryBigInt(s: string | undefined | null): bigint | null {
  if (s === undefined || s === null || s === "") return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

const isAddress = (s: unknown): s is Address =>
  typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

const isHex = (s: unknown): s is Hex =>
  typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);

// ---------------------------------------------------------------------------
// In-memory store (per browser session)
// ---------------------------------------------------------------------------

const policies = new Map<string, Policy>();
const decisions: Decision[] = [];

export function listPolicies(): Policy[] {
  return [...policies.values()];
}

export function getPolicy(id: string): Policy | undefined {
  return policies.get(id);
}

export function listDecisions(): Decision[] {
  return decisions;
}

export function updateDecision(d: Decision): void {
  const i = decisions.findIndex((x) => x.id === d.id);
  if (i >= 0) decisions[i] = d;
}

interface PolicyInputBody {
  owner?: string;
  rules?: PolicyRules;
  remediation?: PolicyRemediation;
}

function createPolicy(body: PolicyInputBody): ApiResult<Policy | unknown> {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (!isAddress(body.owner)) {
    issues.push({ path: ["owner"], message: "Please enter a valid wallet address that starts with 0x and has 40 characters." });
  }
  const rules = body.rules ?? {};
  if (rules.allowedDestinations !== undefined) {
    if (!Array.isArray(rules.allowedDestinations) || rules.allowedDestinations.some((a) => !isAddress(a))) {
      issues.push({ path: ["rules", "allowedDestinations"], message: "Each allowed destination must be a valid address starting with 0x." });
    }
  }
  if (rules.forbiddenSelectors !== undefined) {
    if (
      !Array.isArray(rules.forbiddenSelectors) ||
      rules.forbiddenSelectors.some((s) => typeof s !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(s))
    ) {
      issues.push({ path: ["rules", "forbiddenSelectors"], message: "Each forbidden action must be a 4-byte code starting with 0x and 8 characters long." });
    }
  }
  if (issues.length > 0) {
    return { ok: false, status: 400, data: { error: "ValidationError", issues } };
  }
  const policy: Policy = {
    id: crypto.randomUUID(),
    owner: body.owner as Address,
    rules: {
      ...(rules.maxTransferEth !== undefined ? { maxTransferEth: rules.maxTransferEth } : {}),
      ...(rules.maxDailyOutflowEth !== undefined ? { maxDailyOutflowEth: rules.maxDailyOutflowEth } : {}),
      ...(rules.allowedDestinations ? { allowedDestinations: rules.allowedDestinations } : {}),
      ...(rules.forbiddenSelectors ? { forbiddenSelectors: rules.forbiddenSelectors.map((s) => s.toLowerCase() as Hex) } : {}),
      ...(rules.approvalCapByToken ? { approvalCapByToken: rules.approvalCapByToken } : {}),
    },
    remediation: body.remediation ?? {},
    version: 1,
    updatedAt: Date.now(),
  };
  policies.set(policy.id, policy);
  return { ok: true, status: 201, data: policy };
}

// ---------------------------------------------------------------------------
// Deterministic decision engine (ported from src/core/engine.ts)
// ---------------------------------------------------------------------------

export function evaluateIntent(intent: TxIntent, policy: Policy): Decision {
  const reasons: string[] = [];
  const rulesMatched: string[] = [];
  let verdict: Verdict = "ALLOW";
  let riskScore = 0;

  const selector = selectorOf(intent.data);
  const forbiddenSelectors = (policy.rules.forbiddenSelectors ?? []).map((s) => s.toLowerCase());
  if (selector && forbiddenSelectors.includes(selector.toLowerCase())) {
    verdict = "BLOCK";
    riskScore = Math.max(riskScore, 95);
    rulesMatched.push("forbiddenSelectors");
    reasons.push(`This transaction calls a forbidden function (${selector}), so it is blocked.`);
    const d: Decision = {
      id: crypto.randomUUID(),
      intent,
      verdict,
      riskScore,
      rulesMatched,
      reasons,
      policyId: policy.id,
      timestamp: Date.now(),
    };
    decisions.push(d);
    return d;
  }

  const valueWei = tryBigInt(intent.value);
  if (valueWei === null) {
    verdict = "REQUIRE_HUMAN_CONFIRMATION";
    riskScore = Math.max(riskScore, 70);
    rulesMatched.push("invalidIntentValue");
    reasons.push(`The amount entered is not a valid number. Please check the value field.`);
  } else if (policy.rules.maxTransferEth !== undefined) {
    const cap = ethToWei(policy.rules.maxTransferEth);
    if (valueWei > cap) {
      verdict = "BLOCK";
      riskScore = Math.max(riskScore, 90);
      rulesMatched.push("maxTransferEth");
      reasons.push(
        `This transfer is for ${weiToEthFloat(valueWei)} BOT, which is more than your ${policy.rules.maxTransferEth} BOT per-transaction limit.`,
      );
    }
  }

  if (policy.rules.maxDailyOutflowEth !== undefined && valueWei !== null) {
    const since = Date.now() - DAY_MS;
    const usedWei = decisions
      .filter((d) => d.intent.from.toLowerCase() === policy.owner.toLowerCase())
      .filter((d) => d.timestamp >= since)
      .filter((d) => d.verdict !== "BLOCK")
      .reduce((sum, d) => {
        const v = tryBigInt(d.intent.value);
        return v === null ? sum : sum + v;
      }, 0n);
    const projected = usedWei + valueWei;
    const cap = ethToWei(policy.rules.maxDailyOutflowEth);
    if (projected > cap) {
      verdict = "BLOCK";
      riskScore = Math.max(riskScore, 88);
      rulesMatched.push("maxDailyOutflowEth");
      reasons.push(
        `This transaction would push your total BOT sent in the last 24 hours to ${weiToEthFloat(projected)} BOT, above your ${policy.rules.maxDailyOutflowEth} BOT daily limit.`,
      );
    }
  }

  if (policy.rules.allowedDestinations && policy.rules.allowedDestinations.length > 0) {
    const allow = policy.rules.allowedDestinations.map((a) => a.toLowerCase());
    if (!allow.includes(intent.to.toLowerCase())) {
      if (verdict === "ALLOW") verdict = "REQUIRE_HUMAN_CONFIRMATION";
      riskScore = Math.max(riskScore, 60);
      rulesMatched.push("allowedDestinations");
      reasons.push(`The destination address ${intent.to} is not in your allowed list. Review before approving.`);
    }
  }

  if (
    selector === ERC20_APPROVE &&
    policy.rules.approvalCapByToken &&
    policy.rules.approvalCapByToken[intent.to.toLowerCase() as Address] !== undefined
  ) {
    const rawCap = policy.rules.approvalCapByToken[intent.to.toLowerCase() as Address]!;
    const cap = tryBigInt(rawCap);
    if (cap === null) {
      if (verdict === "ALLOW") verdict = "REQUIRE_HUMAN_CONFIRMATION";
      riskScore = Math.max(riskScore, 70);
      rulesMatched.push("invalidApprovalCap");
      reasons.push(`The approval cap for token ${intent.to} is not set correctly. Review your policy.`);
    } else {
      const amount = decodeUint256(intent.data, 1);
      if (amount !== null && amount > cap) {
        verdict = "BLOCK";
        riskScore = Math.max(riskScore, 92);
        rulesMatched.push("approvalCapByToken");
        reasons.push(`This approval lets the spender take more BOT than your ${ethers.formatEther(cap)} BOT cap on token ${intent.to}.`);
      }
    }
  }

  if (verdict === "ALLOW" && reasons.length === 0) {
    reasons.push("All policy rules satisfied.");
  }

  const d: Decision = {
    id: crypto.randomUUID(),
    intent,
    verdict,
    riskScore,
    rulesMatched,
    reasons,
    policyId: policy.id,
    timestamp: Date.now(),
  };
  decisions.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Endpoint dispatcher — same shape the Fastify server exposed
// ---------------------------------------------------------------------------

interface EvaluateBody {
  policyId?: string;
  intent?: Partial<TxIntent>;
}

function handleEvaluate(body: EvaluateBody): ApiResult<Decision | unknown> {
  const issues: Array<{ path: string[]; message: string }> = [];
  const policy = body.policyId ? policies.get(body.policyId) : undefined;
  if (!policy) {
    issues.push({ path: ["policyId"], message: "Please create or select a policy before evaluating a transaction." });
  }
  const intent = body.intent ?? {};
  if (!isAddress(intent.from)) issues.push({ path: ["intent", "from"], message: "The 'From' address is not valid. It should start with 0x and have 40 characters." });
  if (!isAddress(intent.to)) issues.push({ path: ["intent", "to"], message: "The 'To' address is not valid. It should start with 0x and have 40 characters." });
  if (intent.data !== undefined && !isHex(intent.data)) issues.push({ path: ["intent", "data"], message: "The calldata field must be valid hex, starting with 0x. Leave it as 0x for a simple transfer." });
  if (issues.length > 0) {
    return { ok: false, status: 400, data: { error: "ValidationError", issues } };
  }
  const fullIntent: TxIntent = {
    from: intent.from as Address,
    to: intent.to as Address,
    value: intent.value ?? "0",
    data: (intent.data ?? "0x") as Hex,
    chainId: Number(intent.chainId ?? 677),
  };
  return { ok: true, status: 201, data: evaluateIntent(fullIntent, policy!) };
}

export function localApi<T>(method: string, path: string, body?: unknown): ApiResult<T> {
  if (method === "GET" && path === "/policies") {
    return { ok: true, status: 200, data: listPolicies() as T };
  }
  if (method === "POST" && path === "/policies") {
    return createPolicy(body as PolicyInputBody) as ApiResult<T>;
  }
  const policyMatch = /^\/policies\/([^/]+)$/.exec(path);
  if (method === "GET" && policyMatch) {
    const id = decodeURIComponent(policyMatch[1] ?? "");
    const p = policies.get(id);
    return p
      ? { ok: true, status: 200, data: p as T }
      : { ok: false, status: 404, data: { error: "NotFound" } as T };
  }
  if (method === "POST" && path === "/evaluate") {
    return handleEvaluate(body as EvaluateBody) as ApiResult<T>;
  }
  if (method === "GET" && path === "/timeline") {
    return { ok: true, status: 200, data: listDecisions() as T };
  }
  return { ok: false, status: 404, data: { error: "NotFound", path } as T };
}
