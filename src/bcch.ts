/**
 * The Banco Central BDE REST transport, shared by every series this library reads.
 *
 * There are two of them now - the daily UF and the monthly IPC - and there will be more.
 * What they have in common is not the data but the FAILURE MODE, and that is what lives
 * here:
 *
 *  - authentication is ONE opaque API Key Token, sent as `token`. It is never split,
 *    parsed or interpreted, and there is no user/password pair on this transport. (The BDE
 *    SOAP service does use a user and a password - a different endpoint, and not the one
 *    this library calls.)
 *  - the service reports failure in the BODY with an HTTP 200. A rejected token comes back
 *    as `Codigo: -5` with a fully-formed `Series` object whose contents are all null. So
 *    `Codigo === 0` is the only gate that means anything, and it is applied here rather
 *    than being re-remembered by each adapter.
 *
 * Nothing in this module reads the environment, so no secret lives in it: the token is
 * always a parameter. That is what makes the request contract testable.
 */

/** The BDE REST endpoint this library calls. */
export const BCCH_REST_ENDPOINT = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx";

/** Attribution shown wherever a value from this service is displayed. */
export const BCCH_SOURCE = "Banco Central de Chile";

/** One observation row, as the service shapes it. */
export type BcchObservation = {
  indexDateString?: string;
  value?: string;
  statusCode?: string;
};

export type BcchResponse = {
  Codigo?: number;
  Descripcion?: string;
  /**
   * `Obs` is nullable, not merely absent. Verified against the live endpoint: an invalid
   * token comes back as HTTP 200 with Codigo -5, "Invalid username or password", and
   * `Series: { descripEsp: null, seriesId: null, Obs: null }` - a fully-formed Series
   * object whose contents are all null. Typing it as optional-only would be a lie about a
   * payload we have actually seen.
   */
  Series?: {
    descripEsp?: string | null;
    seriesId?: string | null;
    Obs?: BcchObservation[] | null;
  } | null;
};

/**
 * The calendar day in Chile, as YYYY-MM-DD.
 *
 * THIS IS NOT A FORMATTING DETAIL. It is the single most consequential line in the UF
 * layer, and getting it wrong shipped a real defect.
 *
 * Banco Central publishes the UF IN ADVANCE: the value for every day from the 10th of one
 * month to the 9th of the next is announced around the 9th. So the series legitimately
 * contains FUTURE observations, with real values and a status of OK - they are not
 * placeholders and no per-row validity check can distinguish them from today's.
 *
 * The only thing that separates "today's UF" from "next Tuesday's UF" is what day it
 * actually is where the visitor is. Chile runs at UTC−3/−4, so from roughly 20:00 or 21:00
 * Chilean time onwards, UTC has already rolled into tomorrow. Asking for a window that
 * ends on the UTC day therefore asked for, received and displayed TOMORROW'S UF for the
 * last three or four hours of every Chilean day - on the homepage strip and inside the
 * mortgage simulator, where every peso figure is derived from it.
 *
 * Observed directly: at 2026-09-10T00:20Z the site showed UF 40.893,78 dated 10/09/2026
 * while it was still 21:20 on 09/09 in Santiago, where the UF was 40.885,63.
 *
 * `sv-SE` is used only because its locale format is already YYYY-MM-DD; the timezone is
 * what matters. `Intl` is in every runtime this code targets, and unlike the arithmetic
 * alternative it stays correct across Chile's DST transitions without a table.
 */
export const CHILE_TZ = "America/Santiago";

export const santiagoDay = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: CHILE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/**
 * YYYY-MM-DD in UTC.
 *
 * Retained for callers that genuinely mean UTC. Anything deciding WHICH OBSERVATION IS
 * CURRENT must use `santiagoDay` instead - see above.
 */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Builds a GetSeries request for an explicit date range.
 *
 * Pure, and the token is a parameter rather than an environment read, so the request
 * contract itself can be asserted in tests without a credential existing.
 */
export function buildRangeUrl({
  token,
  series,
  firstdate,
  lastdate,
  base = BCCH_REST_ENDPOINT,
}: {
  token: string;
  series: string;
  firstdate: string;
  lastdate: string;
  base?: string;
}): URL {
  const url = new URL(base);
  url.searchParams.set("token", token);
  url.searchParams.set("function", "GetSeries");
  url.searchParams.set("timeseries", series);
  url.searchParams.set("firstdate", firstdate);
  url.searchParams.set("lastdate", lastdate);
  return url;
}

/**
 * The usable observations of a successful payload, in the order the service returned them
 * (ascending by date), or an empty array.
 *
 * Two gates, and the first is the important one:
 *
 *  1. `Codigo` must be exactly 0. Anything else, including the field being absent, means
 *     this is not a payload we recognise as successful and NOTHING in it may be labelled
 *     official.
 *  2. Each row must carry a positive numeric `value` and, where the service states one, a
 *     `statusCode` of "OK". Unpublished periods come back as "ND" with an empty value.
 */
export function usableObservations(
  body: BcchResponse
): { date: string | undefined; value: number }[] {
  if (body?.Codigo !== 0) return [];

  const rows: { date: string | undefined; value: number }[] = [];
  for (const obs of body?.Series?.Obs ?? []) {
    if (!obs?.value) continue;
    if (obs.statusCode && obs.statusCode.toUpperCase() !== "OK") continue;
    const value = Number(obs.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    rows.push({ date: obs.indexDateString, value });
  }
  return rows;
}

/** "DD-MM-YYYY" → "YYYY-MM-DD". Null for anything unexpected. */
export function isoFromBcch(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
