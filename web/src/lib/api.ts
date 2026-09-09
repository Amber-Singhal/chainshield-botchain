import { localApi } from "./local.js";
import type { ApiResult } from "./types.js";

/**
 * ChainShield on BOT Chain runs the full risk gate client-side: policies,
 * the deterministic rule engine and the decision timeline all live in this
 * module's in-memory store. `api` keeps the original request/response
 * signature so the UI code is unchanged — only the transport moved.
 */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return localApi<T>(method, path, body);
}
