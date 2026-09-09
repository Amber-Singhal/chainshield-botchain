import { api } from "./api.js";
import { recordDecisionOnChain } from "./botchain.js";
import { updateDecision } from "./local.js";
import {
  escapeHtml,
  gaugeSvg,
  renderReason,
  summarizeZodIssues,
  verdictKlass,
  verdictWord,
} from "./format.js";
import { showJsonModal } from "./modal.js";
import { loadTimeline } from "./timeline.js";
import { ATTACKER, COLD_VAULT, TOKEN, TREASURY } from "./policies.js";
import { getConnectedAccount } from "./wallet.js";
import {
  loadOnChainPolicyForEvaluation,
  onChainPolicyToLocalRules,
} from "./onchain-policy.js";
import { evaluateIntent } from "./local.js";
import type { Decision, Policy } from "./types.js";

declare global {
  interface Window {
    _lastDecision?: Decision | null;
    _lastErrorData?: unknown;
  }
}

type FieldEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function getField(form: HTMLFormElement, name: string): string {
  const el = form.querySelector<FieldEl>(`[name="${name}"]`);
  return (el?.value ?? "").trim();
}

export async function submitEvaluateForm(form: HTMLFormElement): Promise<void> {
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const originalLabel = submitBtn?.innerHTML ?? "Evaluate";
  setSubmitBusy(submitBtn, true);
  const stopLoader = renderEvaluateLoading();
  try {
    const r = await evaluateWithPolicy(form);
    stopLoader();
    renderEvaluate(r);
    await loadTimeline();
  } finally {
    setSubmitBusy(submitBtn, false, originalLabel);
  }
}

async function evaluateWithPolicy(form: HTMLFormElement): Promise<{ ok: boolean; status: number; data: unknown }> {
  const policyId = getField(form, "policyId");
  const intent = {
    from: getField(form, "from") as `0x${string}`,
    to: getField(form, "to") as `0x${string}`,
    value: getField(form, "value") || "0",
    data: (getField(form, "data") || "0x") as `0x${string}`,
    chainId: Number(getField(form, "chainId") || "677"),
  };

  // If the user chose "Use my on-chain policy" (empty policyId + wallet connected), read live policy.
  if (!policyId) {
    const onchain = await loadOnChainPolicyForEvaluation();
    if (onchain) {
      const policy: Policy = {
        id: "onchain",
        owner: intent.from,
        rules: onChainPolicyToLocalRules(onchain),
        remediation: {},
        version: Number(onchain.version),
        updatedAt: Number(onchain.updatedAt) * 1000,
      };
      const decision = evaluateIntentWithPolicy(intent, policy);
      return { ok: true, status: 201, data: decision };
    }
  }

  // Otherwise use the local engine (demo policies or selected local policy).
  return api<Decision>("POST", "/evaluate", { policyId, intent });
}

function evaluateIntentWithPolicy(intent: { from: `0x${string}`; to: `0x${string}`; value: string; data: `0x${string}`; chainId: number }, policy: Policy): Decision {
  return evaluateIntent(intent, policy);
}

function setSubmitBusy(
  btn: HTMLButtonElement | null,
  busy: boolean,
  restoreLabel?: string,
): void {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle("is-busy", busy);
  if (busy) {
    btn.innerHTML =
      '<span class="btn-spinner" aria-hidden="true"></span><span>Evaluating</span>';
  } else if (restoreLabel !== undefined) {
    btn.innerHTML = restoreLabel;
  }
}

/**
 * Render an interim "working" panel while the intent is evaluated.
 * The engine is fully client-side so this is brief, but a live elapsed
 * timer plus an explicit phase list keeps the user oriented.
 *
 * Returns a function that stops the timer and clears the interval.
 */
function renderEvaluateLoading(): () => void {
  const el = document.getElementById("evaluate-result");
  if (!el) return () => {};
  const start = performance.now();
  el.innerHTML =
    '<span class="verdict-corner">Working</span>' +
    '<div class="verdict-loading">' +
    '<div class="verdict-result-head">' +
    "<span>Evaluating intent</span>" +
    "</div>" +
    '<h3 class="verdict-stamp accent">Working.</h3>' +
    '<div class="verdict-loading-bar" aria-hidden="true"><span></span></div>' +
    '<div class="verdict-loading-row">' +
    '<div class="verdict-loading-elapsed" data-loading-elapsed>0.0s</div>' +
    '<div class="verdict-loading-label">Elapsed</div>' +
    "</div>" +
    '<ul class="reasons verdict-loading-reasons">' +
    "<li>Validating intent against the policy schema.</li>" +
    "<li>Running the deterministic rule ladder.</li>" +
    "<li>Decoding ERC-20 calldata via the heuristic decoder.</li>" +
    "<li>Scoring risk and stamping the verdict.</li>" +
    "</ul>" +
    "</div>";
  const elapsedEl = el.querySelector<HTMLElement>("[data-loading-elapsed]");
  const timer = window.setInterval(() => {
    if (!elapsedEl) return;
    const sec = (performance.now() - start) / 1000;
    elapsedEl.textContent = `${sec.toFixed(1)}s`;
  }, 100);
  return () => window.clearInterval(timer);
}

function renderEvaluate(r: { ok: boolean; status: number; data: unknown }): void {
  const el = document.getElementById("evaluate-result");
  if (!el) return;
  if (!r.ok) {
    window._lastDecision = null;
    window._lastErrorData = r.data;
    el.innerHTML =
      '<span class="verdict-corner">Error</span>' +
      '<div class="verdict-result">' +
      '<div class="verdict-result-head"><span>Request failed</span>' +
      '<button type="button" class="btn-link" data-action="show-error-json">View JSON</button>' +
      "</div>" +
      '<h3 class="verdict-stamp block">Error</h3>' +
      '<div class="verdict-error">' +
      escapeHtml(JSON.stringify(r.data, null, 2)) +
      "</div>" +
      "</div>";
    el.querySelector('[data-action="show-error-json"]')?.addEventListener("click", () => {
      showJsonModal("Request error", window._lastErrorData, {
        summaryHtml: summarizeZodIssues(window._lastErrorData),
      });
    });
    return;
  }
  const d = r.data as Decision;
  window._lastDecision = d;
  const klass = verdictKlass(d.verdict);
  const reasons = (d.reasons ?? [])
    .map((x) => `<li>${renderReason(x)}</li>`)
    .join("");
  const rules = (d.rulesMatched ?? [])
    .map((x) => `<span class="badge">${escapeHtml(x)}</span>`)
    .join("");
  const playbookBadge = d.playbookTriggered
    ? `<div class="playbook-badge">playbook fired · ${escapeHtml(d.playbookTriggered.id)} / run ${escapeHtml(d.playbookTriggered.runId)}</div>`
    : "";
  const idShort = d.id ? d.id.slice(0, 8) : "";

  el.innerHTML =
    '<span class="verdict-corner">Verdict</span>' +
    '<div class="verdict-result">' +
    '<div class="verdict-result-head">' +
    `<span>Decision · ${escapeHtml(idShort)}…</span>` +
    '<button type="button" class="btn-link" data-action="show-decision-json">View JSON</button>' +
    "</div>" +
    `<h3 class="verdict-stamp ${klass}">${escapeHtml(verdictWord(d.verdict))}.</h3>` +
    '<div class="verdict-meta">' +
    `<div class="verdict-meta-item">verdict · <strong>${escapeHtml(d.verdict)}</strong></div>` +
    `<div class="verdict-meta-item">timestamp · <strong>${new Date(d.timestamp).toLocaleTimeString()}</strong></div>` +
    "</div>" +
    '<div class="verdict-gauge-wrap">' +
    `<div class="verdict-gauge ${klass}">${gaugeSvg(d.riskScore)}</div>` +
    '<div class="verdict-gauge-readout">' +
    `<div class="verdict-gauge-value">${escapeHtml(String(d.riskScore))}<span class="max"> / 100</span></div>` +
    '<div class="verdict-gauge-label">Risk score</div>' +
    "</div>" +
    "</div>" +
    (rules ? `<div class="badge-row">${rules}</div>` : "") +
    playbookBadge +
    `<ul class="reasons">${reasons}</ul>` +
    (d.anchor && d.anchor.txHash
      ? `<div class="verdict-record"><a class="btn-link" href="https://scan.botchain.ai/tx/${escapeHtml(d.anchor.txHash)}" target="_blank" rel="noopener noreferrer">Recorded on BOT Chain · view on BOTScan</a></div>`
      : '<div class="verdict-record"><button type="button" class="btn-chip" data-action="record-onchain">Record on BOT Chain</button><span class="verdict-record-status" data-record-status></span></div>') +
    "</div>";
  el.querySelector('[data-action="show-decision-json"]')?.addEventListener("click", () => {
    if (window._lastDecision) {
      showJsonModal(`Decision ${window._lastDecision.id}`, window._lastDecision);
    }
  });
  el.querySelector('[data-action="record-onchain"]')?.addEventListener("click", () => {
    void recordCurrentDecision(el);
  });
}

async function recordCurrentDecision(el: HTMLElement): Promise<void> {
  const d = window._lastDecision;
  if (!d) return;
  const status = el.querySelector<HTMLElement>("[data-record-status]");
  const btn = el.querySelector<HTMLButtonElement>('[data-action="record-onchain"]');
  if (btn) btn.disabled = true;
  if (status) status.textContent = " connecting wallet…";
  try {
    const anchor = await recordDecisionOnChain(d);
    d.anchor = anchor;
    updateDecision(d);
    await loadTimeline();
    renderEvaluate({ ok: true, status: 200, data: d });
  } catch (err) {
    if (btn) btn.disabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    if (status) status.textContent = ` ${msg.replace(/\s+/g, " ").slice(0, 140)}`;
  }
}

function setEvaluateForm(updates: Record<string, string>): void {
  const f = document.getElementById("evaluate-form") as HTMLFormElement | null;
  if (!f) return;
  for (const [name, value] of Object.entries(updates)) {
    const el = f.querySelector<FieldEl>(`[name="${name}"]`);
    if (el) el.value = value;
  }
}

export function presetSafeTransfer(): void {
  setEvaluateForm({
    from: TREASURY,
    to: COLD_VAULT,
    value: "500000000000000000",
    data: "0x",
  });
}

export function presetOverCap(): void {
  setEvaluateForm({
    from: TREASURY,
    to: COLD_VAULT,
    value: "5000000000000000000",
    data: "0x",
  });
}

export function presetForbiddenApprove(): void {
  const spender = ATTACKER.slice(2).toLowerCase().padStart(64, "0");
  const amount = "f".repeat(64);
  setEvaluateForm({
    from: TREASURY,
    to: TOKEN,
    value: "0",
    data: `0x095ea7b3${spender}${amount}`,
  });
}

export function presetUnknownDest(): void {
  setEvaluateForm({
    from: TREASURY,
    to: ATTACKER,
    value: "100000000000000000",
    data: "0x",
  });
}

export function fillFromAddress(address: string): void {
  setEvaluateForm({ from: address });
}

export function useOnChainPolicyInEvaluate(): void {
  const select = document.getElementById("policy-select") as HTMLSelectElement | null;
  if (select) select.value = "";
}
