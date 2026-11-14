import { BCCH_REST_ENDPOINT, buildRangeUrl, santiagoDay, type BcchResponse } from "./bcch.ts";
import { IPC_FIRST_MONTH, IPC_SERIES, parseIpcSeries } from "./ipc-parse.ts";
import type { IpcSeries } from "./ipc-types.ts";

/**
 * Fetches the official monthly IPC series from the Banco Central de Chile BDE REST API.
 *
 * The API token is always a parameter: this module never reads the environment, never logs
 * the token and never caches it. Returns null, never throws and never guesses, for every
 * failure mode: a non-200, a non-zero service code, a timeout, a changed payload, or a
 * response with no usable observation. If there is no index, nothing should be computed.
 *
 * Get a free token at https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/index.htm
 */
export async function fetchIpcSeries({
  token,
  base = BCCH_REST_ENDPOINT,
  timeoutMs = 8000,
}: {
  token: string;
  base?: string;
  timeoutMs?: number;
}): Promise<IpcSeries | null> {
  if (!token?.trim()) return null;
  const url = buildRangeUrl({
    token: token.trim(),
    series: IPC_SERIES,
    firstdate: `${IPC_FIRST_MONTH}-01`,
    lastdate: santiagoDay(),
    base,
  });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parseIpcSeries((await res.json()) as BcchResponse);
  } catch {
    return null;
  }
}
