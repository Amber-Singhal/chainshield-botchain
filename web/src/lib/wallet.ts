import { connectWallet, getAccount, getBalance, BOT_CHAIN_ID, BOT_EXPLORER } from "./botchain.js";

declare global {
  interface Window {
    _connectedAccount?: string | null;
    _connectedChainId?: number | null;
  }
}

type Listener = () => void;
const listeners: Listener[] = [];

export function onWalletChange(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function getConnectedAccount(): string | null {
  return window._connectedAccount ?? null;
}

export function isConnectedToBotChain(): boolean {
  return window._connectedChainId === BOT_CHAIN_ID;
}

export async function refreshWallet(): Promise<void> {
  const account = await getAccount();
  window._connectedAccount = account ?? undefined;
  if (typeof window.ethereum !== "undefined") {
    try {
      const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      window._connectedChainId = Number(chainId);
    } catch {
      window._connectedChainId = null;
    }
  }
  emit();
}

export async function performConnect(): Promise<void> {
  await connectWallet();
  await refreshWallet();
}

/**
 * Disconnect the dapp's session. Some wallets support the revoke API; for
 * others we just clear the frontend state so the user can re-connect.
 */
export async function disconnectWallet(): Promise<void> {
  if (typeof window.ethereum !== "undefined") {
    try {
      // EIP-2255 revoke permission, supported by MetaMask and a few others
      await window.ethereum.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // wallet doesn't support revocation — just clear app state
    }
  }
  window._connectedAccount = null;
  window._connectedChainId = null;
  emit();
}

export function bindWalletEvents(): void {
  const eth = window.ethereum;
  if (!eth) return;
  eth.on?.("accountsChanged", () => {
    void refreshWallet();
  });
  eth.on?.("chainChanged", () => {
    void refreshWallet();
  });
}

export async function updateWalletUI(): Promise<void> {
  const connectBtn = document.getElementById("connect-wallet") as HTMLButtonElement | null;
  const info = document.getElementById("wallet-info");
  const addressEl = document.getElementById("wallet-address");
  const balanceEl = document.getElementById("wallet-balance");
  const account = getConnectedAccount();

  if (!connectBtn) return;

  if (!account) {
    connectBtn.style.display = "";
    connectBtn.textContent = "Connect wallet";
    connectBtn.disabled = false;
    if (info) info.style.display = "none";
    document.querySelectorAll<HTMLButtonElement>("[data-action='use-connected-address'], [data-action='use-onchain-policy'], [data-action='save-onchain-policy']").forEach((btn) => {
      btn.disabled = true;
    });
    return;
  }

  connectBtn.style.display = "none";
  if (info) info.style.display = "flex";
  document.querySelectorAll<HTMLButtonElement>("[data-action='use-connected-address'], [data-action='use-onchain-policy'], [data-action='save-onchain-policy']").forEach((btn) => {
    btn.disabled = false;
  });
  if (addressEl) {
    addressEl.innerHTML = `<a href="${BOT_EXPLORER}/address/${account}" target="_blank" rel="noopener">${account.slice(0, 6)}…${account.slice(-4)}</a>`;
  }
  if (balanceEl) {
    try {
      const bal = await getBalance(account);
      balanceEl.textContent = `${Number(bal).toFixed(4)} BOT`;
    } catch {
      balanceEl.textContent = "";
    }
  }
}
