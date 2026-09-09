import { getConnectedAccount } from "./wallet.js";
import {
  explorerTxUrl,
  loadOnChainPolicy,
  setOnChainPolicy,
  type OnChainPolicy,
  type PolicyInput,
} from "./botchain.js";
import { escapeHtml, formatRules } from "./format.js";
import { TREASURY, COLD_VAULT, ATTACKER, TOKEN } from "./policies.js";
import type { Address } from "./types.js";

/**
 * Renders the on-chain policy card for the connected wallet and handles
 * reading/writing the live policy stored in ChainShield.sol.
 */

const DEFAULT_DEMO: PolicyInput = {
  active: true,
  maxTransferEth: 1,
  maxDailyOutflowEth: 3,
  allowedDestinations: [COLD_VAULT],
  forbiddenSelectors: ["0x095ea7b3"],
  approvalCapByToken: { [TOKEN]: "1000000000000000000000" },
};

function parseAddresses(s: string): Address[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x))
    .map((x) => x.toLowerCase() as Address);
}

function parseSelectors(s: string): `0x${string}`[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^0x[0-9a-fA-F]{8}$/.test(x))
    .map((x) => x.toLowerCase() as `0x${string}`);
}

function parseTokenCaps(s: string): Partial<Record<Address, string>> {
  const out: Partial<Record<Address, string>> = {};
  for (const part of s.split(",")) {
    const [token, cap] = part.split("=").map((x) => x.trim());
    if (token && /^0x[0-9a-fA-F]{40}$/.test(token) && /^\d+$/.test(cap)) {
      out[token.toLowerCase() as Address] = cap;
    }
  }
  return out;
}

function tokenCapsString(caps: Partial<Record<Address, string>>): string {
  return Object.entries(caps)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function policyFormToInput(form: HTMLFormElement): PolicyInput {
  const get = (name: string) => {
    const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    return el?.value.trim() ?? "";
  };
  return {
    active: true,
    maxTransferEth: Number(get("maxTransferEth")) || 0,
    maxDailyOutflowEth: Number(get("maxDailyOutflowEth")) || 0,
    allowedDestinations: parseAddresses(get("allowedDestinations")),
    forbiddenSelectors: parseSelectors(get("forbiddenSelectors")),
    approvalCapByToken: parseTokenCaps(get("approvalCapByToken")),
  };
}

export function fillPolicyForm(form: HTMLFormElement | null, p: PolicyInput): void {
  if (!form) return;
  const fields: Record<string, string> = {
    maxTransferEth: String(p.maxTransferEth),
    maxDailyOutflowEth: String(p.maxDailyOutflowEth),
    allowedDestinations: p.allowedDestinations.join(", "),
    forbiddenSelectors: p.forbiddenSelectors.join(", "),
    approvalCapByToken: tokenCapsString(p.approvalCapByToken),
  };
  for (const [name, value] of Object.entries(fields)) {
    const el = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (el) el.value = value;
  }
}

export async function refreshOnChainPolicyCard(): Promise<void> {
  const account = getConnectedAccount();
  const wrap = document.getElementById("onchain-policy-wrap");
  const card = document.getElementById("onchain-policy-card");
  const saveBtn = document.getElementById("save-onchain-policy") as HTMLButtonElement | null;
  const useBtn = document.getElementById("use-onchain-policy") as HTMLButtonElement | null;
  if (!wrap || !card) return;

  if (!account) {
    wrap.style.display = "";
    card.innerHTML = '<div class="empty">Connect a wallet to view your on-chain policy.</div>';
    if (saveBtn) saveBtn.disabled = true;
    if (useBtn) useBtn.disabled = true;
    return;
  }

  wrap.style.display = "block";
  if (saveBtn) saveBtn.disabled = false;
  if (useBtn) useBtn.disabled = false;

  try {
    const policy = await loadOnChainPolicy(account);
    if (!policy) {
      card.innerHTML = '<div class="empty">No on-chain policy yet. Use the form on the left to save one.</div>';
      fillPolicyForm(document.getElementById("policy-form") as HTMLFormElement | null, DEFAULT_DEMO);
      return;
    }
    const rules = {
      maxTransferEth: policy.maxTransferEth,
      maxDailyOutflowEth: policy.maxDailyOutflowEth,
      allowedDestinations: policy.allowedDestinations,
      forbiddenSelectors: policy.forbiddenSelectors,
      approvalCapByToken: policy.approvalCapByToken,
    };
    card.innerHTML = `
      <div class="policy-card-row">
        <span class="policy-card-owner">${escapeHtml(account)}</span>
        <span class="policy-card-version">v${policy.version.toString()}</span>
      </div>
      <div class="policy-card-id">On-chain policy · updated ${new Date(Number(policy.updatedAt) * 1000).toLocaleString()}</div>
      <div class="policy-card-rules">${escapeHtml(formatRules(rules))}</div>
    `;
    fillPolicyForm(document.getElementById("policy-form") as HTMLFormElement | null, policy);
  } catch (err) {
    card.innerHTML = `<div class="empty">Could not read on-chain policy: ${escapeHtml((err as Error).message)}</div>`;
  }
}

export async function saveOnChainPolicyFromForm(form: HTMLFormElement): Promise<void> {
  const account = getConnectedAccount();
  if (!account) throw new Error("Connect a wallet first.");
  const input = policyFormToInput(form);
  const txHash = await setOnChainPolicy(input);
  await refreshOnChainPolicyCard();
  return txHash as unknown as void;
}

export async function loadOnChainPolicyForEvaluation(): Promise<OnChainPolicy | null> {
  const account = getConnectedAccount();
  if (!account) return null;
  return loadOnChainPolicy(account);
}

export function onChainPolicyToLocalRules(p: OnChainPolicy) {
  return {
    maxTransferEth: p.maxTransferEth,
    maxDailyOutflowEth: p.maxDailyOutflowEth,
    allowedDestinations: p.allowedDestinations,
    forbiddenSelectors: p.forbiddenSelectors,
    approvalCapByToken: p.approvalCapByToken,
  };
}
