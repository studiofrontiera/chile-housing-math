import { BCCH_SOURCE, isoFromBcch, usableObservations, type BcchResponse } from "./bcch.ts";
import type { IpcPoint, IpcSeries, RentAdjustment } from "./ipc-types.ts";

/**
 * The pure half of the IPC layer: reading a Banco Central payload into a monthly index,
 * and adjusting an amount between two months.
 *
 * Network access lives in `src/client.ts`, which takes the API token as a parameter. The
 * decisions that actually matter live here, free of I/O, where they can be asserted.
 *
 * What matters here is not arithmetic difficulty; the arithmetic is one division. It is
 * that a reajuste is a number two parties will argue about. Every guard below exists so
 * that this library either produces a figure both of them can check against the published
 * index, or produces nothing at all.
 */

/**
 * Índice de precios al consumidor, serie empalmada, base anual 2023 = 100, monthly.
 *
 * The IPC is compiled and published by the Instituto Nacional de Estadísticas. This library
 * reads it from the Banco Central BDE because that is a documented, credentialled, machine
 * readable redistribution of the same official figures - not a scrape of INE's site. The
 * attribution shown to a visitor names both: INE compiles it, Banco Central serves it.
 *
 * The `EP23` segment is the base year and is load-bearing: `F074.IPC.IND.Z.EP.C.M` without
 * it is not a series the service knows, and BDE answers an unknown identifier the same way
 * it answers a rejected token - an HTTP 200 with a non-zero `Codigo`. That is exactly the
 * case the resolution chain treats as "no index", so the first deployment of this adapter
 * rendered a correct, honest unavailable state rather than a wrong number. Worth keeping
 * in mind if the Banco Central ever rebases the series: it will get a new identifier, this
 * one will stop resolving, and the tool will go quiet rather than go wrong.
 */
export const IPC_SERIES = "F074.IPC.IND.Z.EP23.C.M";

/** Who actually produces the figures, as distinct from who serves them to us. */
export const IPC_COMPILER = "Instituto Nacional de Estadísticas";

/**
 * The first month the chained series carries. Requests start here rather than at an
 * arbitrary recent date: a lease signed years ago is exactly the case this tool exists for,
 * and the whole series is a couple of hundred numbers.
 */
export const IPC_FIRST_MONTH = "2009-12";

/** "YYYY-MM" for a Date, in UTC. */
export const monthOf = (d: Date): string => d.toISOString().slice(0, 7);

/** True for a well-formed "YYYY-MM". Says nothing about the month existing in the series. */
export const isMonthKey = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v.trim());

/**
 * Reads a REST payload into an ascending monthly index, or null.
 *
 * Null - never a partial or empty series - for every failure mode, so a caller cannot
 * accidentally render an index with no points in it as though it were data. `Codigo === 0`
 * and the per-row status checks are applied by `usableObservations`; what is added here is
 * that a monthly observation must reduce to a real month, and that duplicates collapse to
 * the LAST value the service gave, which is how a revision arrives.
 */
export function parseIpcSeries(body: BcchResponse): IpcSeries | null {
  const byMonth = new Map<string, number>();

  for (const row of usableObservations(body)) {
    const iso = isoFromBcch(row.date);
    if (!iso) continue;
    byMonth.set(iso.slice(0, 7), row.value);
  }

  if (byMonth.size === 0) return null;

  const points: IpcPoint[] = [...byMonth.entries()]
    .map(([month, index]) => ({ month, index }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    points,
    source: BCCH_SOURCE,
    seriesId: body?.Series?.seriesId?.trim() || IPC_SERIES,
    description: body?.Series?.descripEsp?.trim() || null,
  };
}

/** The point for an exact month, or null. No nearest-month guessing: see `adjustRent`. */
export function pointFor(series: IpcSeries, month: string): IpcPoint | null {
  return series.points.find((p) => p.month === month) ?? null;
}

/** The most recent month the series carries. */
export const latestPoint = (series: IpcSeries): IpcPoint =>
  series.points[series.points.length - 1];

/**
 * Accumulated variation between two published months, as a ratio.
 *
 * `to / from - 1`. This is the same figure a reader gets by dividing the two index levels
 * printed by INE, which is the point: the answer has to be reproducible by hand.
 */
export const accumulatedVariation = (from: IpcPoint, to: IpcPoint): number =>
  to.index / from.index - 1;

/**
 * The OFFICIAL variation for a period: a ratio expressed to one decimal place as a
 * percentage. 0.0413226 becomes 0.041.
 *
 * The IPC's official variation is published to one decimal - INE says so on its own
 * calculator, and its Calculadora IPC adjusts monetary values by that one-decimal figure
 * rather than by the raw quotient of two index levels. Applying the same rule is what
 * makes this library agree with the official tool exactly instead of by a couple of hundred
 * pesos; the five cases in `test/ipc.test.ts` are the evidence.
 *
 * Rounds half AWAY FROM ZERO rather than using `Math.round`, whose half-up behaviour is
 * asymmetric for negatives: `Math.round(-1.5)` is -1, so a deflationary −0,15% would round
 * to −0,1% while an inflationary +0,15% rounded to +0,2%. Rare, and no reason to be
 * inconsistent about it.
 */
export function officialVariation(accumulated: number): number {
  const pct = accumulated * 100;
  const rounded = Math.sign(pct) * Math.round(Math.abs(pct) * 10) / 10;
  // Back through a fixed-precision string: 4.1/100 is 0.040999999999999995 in binary
  // floating point, and that error would surface in a peso figure.
  return Number((rounded / 100).toFixed(4));
}

/**
 * Adjusts an amount for the IPC accumulated between two months, or returns null.
 *
 * Null whenever the answer would have to be invented:
 *
 *  - either month is absent from the published series. It is NOT rounded to the nearest
 *    available month. The most likely request is the month that has not been published
 *    yet, and quietly substituting the previous one would change the rent by a real
 *    amount without telling anyone;
 *  - the period runs backwards. A lease is adjusted forwards;
 *  - the amount is not a positive finite number.
 *
 * A period of zero length is allowed and returns the amount unchanged with a variation of
 * zero, which is a true statement rather than an error.
 *
 * The MONEY is adjusted by the official one-decimal variation, not by the raw quotient of
 * the two index levels - see `officialVariation`. Both numbers are returned: the raw one
 * is what the audit line shows, because it is what a reader reproduces from the two
 * published figures; the official one is what INE applies, and therefore what a landlord
 * and a tenant will both arrive at.
 */
export function adjustRent({
  series,
  amountClp,
  fromMonth,
  toMonth,
}: {
  series: IpcSeries;
  amountClp: number;
  fromMonth: string;
  toMonth: string;
}): RentAdjustment | null {
  if (!Number.isFinite(amountClp) || amountClp <= 0) return null;
  if (fromMonth > toMonth) return null;

  const from = pointFor(series, fromMonth);
  const to = pointFor(series, toMonth);
  if (!from || !to) return null;

  const accumulated = accumulatedVariation(from, to);
  const officialRatio = officialVariation(accumulated);
  const adjustedClp = amountClp * (1 + officialRatio);

  return {
    from,
    to,
    accumulated,
    officialRatio,
    adjustedClp,
    differenceClp: adjustedClp - amountClp,
  };
}

/**
 * Variation over the twelve months ending at the series' last published month - the
 * headline "IPC 12 meses" figure. Null when the series is too short to state one, which is
 * the only honest answer in that case.
 */
export function twelveMonthVariation(series: IpcSeries): { point: IpcPoint; ratio: number } | null {
  const last = latestPoint(series);
  if (!last) return null;

  const [y, m] = last.month.split("-").map(Number);
  const yearAgo = `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
  const before = pointFor(series, yearAgo);
  if (!before) return null;

  return { point: last, ratio: accumulatedVariation(before, last) };
}

/**
 * The months a select should offer, newest first.
 *
 * Derived from the series rather than generated from a calendar, so the interface can only
 * ever offer a month the tool can actually compute - the select and the calculation cannot
 * drift apart.
 */
export const availableMonths = (series: IpcSeries): string[] =>
  series.points.map((p) => p.month).reverse();
