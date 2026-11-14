import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BCCH_REST_ENDPOINT, buildRangeUrl, type BcchResponse } from "../src/bcch.ts";
import {
  accumulatedVariation,
  adjustRent,
  availableMonths,
  IPC_SERIES,
  isMonthKey,
  officialVariation,
  latestPoint,
  parseIpcSeries,
  pointFor,
  twelveMonthVariation,
} from "../src/ipc-parse.ts";
import type { IpcSeries } from "../src/ipc-types.ts";

/**
 * The IPC layer's pure decisions.
 *
 * The stake here is different from the mortgage calculator's. A dividendo is an estimate a
 * visitor uses to think with; a reajuste is a figure two parties put in a lease. So most of
 * the assertions below are about REFUSING to answer: an unpublished month, a backwards
 * period, a rejected token that arrives dressed as an HTTP 200. Producing a plausible rent
 * from an index we do not actually have is the failure this file exists to prevent.
 */

const obs = (indexDateString: string, value: string, statusCode = "OK") => ({
  indexDateString,
  value,
  statusCode,
});

const ok = (rows: ReturnType<typeof obs>[]): BcchResponse => ({
  Codigo: 0,
  Descripcion: "",
  Series: { descripEsp: "Índice IPC general", seriesId: IPC_SERIES, Obs: rows },
});

/** A small ascending index, enough to reason about. */
const series = (): IpcSeries => {
  const parsed = parseIpcSeries(
    ok([
      obs("01-01-2024", "100"),
      obs("01-02-2024", "101"),
      obs("01-03-2024", "102"),
      obs("01-01-2025", "105"),
    ])
  );
  assert.ok(parsed);
  return parsed;
};

describe("buildRangeUrl - REST request contract", () => {
  const url = buildRangeUrl({
    token: "test-api-key-token",
    series: IPC_SERIES,
    firstdate: "2009-12-01",
    lastdate: "2026-09-09",
  });

  test("sends the API Key Token as a single opaque token parameter", () => {
    assert.equal(url.searchParams.get("token"), "test-api-key-token");
    // The important negative assertion on this transport: BDE REST takes no user/password
    // pair, and inventing one is exactly how the adapter was broken once before.
    assert.equal(url.searchParams.get("user"), null);
    assert.equal(url.searchParams.get("pass"), null);
  });

  test("asks GetSeries for the IPC series over the stated range", () => {
    assert.equal(url.origin + url.pathname, BCCH_REST_ENDPOINT);
    assert.equal(url.searchParams.get("function"), "GetSeries");
    assert.equal(url.searchParams.get("timeseries"), IPC_SERIES);
    assert.equal(url.searchParams.get("firstdate"), "2009-12-01");
    assert.equal(url.searchParams.get("lastdate"), "2026-09-09");
  });
});

describe("parseIpcSeries - what may become an index", () => {
  test("reads observations into an ascending monthly index", () => {
    const s = series();
    assert.deepEqual(
      s.points.map((p) => p.month),
      ["2024-01", "2024-02", "2024-03", "2025-01"]
    );
    assert.equal(s.points[0].index, 100);
    assert.equal(s.source, "Banco Central de Chile");
    assert.equal(s.seriesId, IPC_SERIES);
    assert.equal(s.description, "Índice IPC general");
  });

  test("sorts an out-of-order payload rather than trusting the order", () => {
    const s = parseIpcSeries(ok([obs("01-03-2024", "102"), obs("01-01-2024", "100")]));
    assert.deepEqual(
      s?.points.map((p) => p.month),
      ["2024-01", "2024-03"]
    );
  });

  test("a rejected token is not an index, despite arriving as a well-formed body", () => {
    const rejected: BcchResponse = {
      Codigo: -5,
      Descripcion: "Invalid username or password",
      Series: { descripEsp: null, seriesId: null, Obs: null },
    };
    assert.equal(parseIpcSeries(rejected), null);
  });

  test("a missing Codigo is not success", () => {
    assert.equal(parseIpcSeries({ Series: { Obs: [obs("01-01-2024", "100")] } }), null);
  });

  test("an empty or all-unusable window yields null, never an empty index", () => {
    assert.equal(parseIpcSeries(ok([])), null);
    assert.equal(parseIpcSeries(ok([obs("01-01-2024", "", "ND")])), null);
    assert.equal(parseIpcSeries(ok([obs("01-01-2024", "0")])), null);
    assert.equal(parseIpcSeries(ok([obs("01-01-2024", "no")])), null);
  });

  test("a revised month collapses to the last value the service gave", () => {
    const s = parseIpcSeries(ok([obs("01-01-2024", "100"), obs("15-01-2024", "100.4")]));
    assert.equal(s?.points.length, 1);
    assert.equal(s?.points[0].index, 100.4);
  });

  test("an unreadable date is skipped rather than guessed at", () => {
    const s = parseIpcSeries(ok([obs("2024-01-01", "100"), obs("01-02-2024", "101")]));
    assert.deepEqual(
      s?.points.map((p) => p.month),
      ["2024-02"]
    );
  });
});

describe("adjustRent - what may become a rent", () => {
  test("adjusts by the accumulated variation between two published months", () => {
    const r = adjustRent({
      series: series(),
      amountClp: 500_000,
      fromMonth: "2024-01",
      toMonth: "2025-01",
    });
    // 105/100 − 1 = 5%.
    assert.ok(r);
    assert.ok(Math.abs(r.accumulated - 0.05) < 1e-12);
    assert.equal(Math.round(r.adjustedClp), 525_000);
    assert.equal(Math.round(r.differenceClp), 25_000);
    assert.equal(r.from.month, "2024-01");
    assert.equal(r.to.month, "2025-01");
  });

  test("refuses a month the series has not published rather than using the nearest one", () => {
    // 2024-04 is absent. The tempting behaviour - fall back to 2024-03 - would change a
    // real rent by a real amount without saying so.
    assert.equal(
      adjustRent({
        series: series(),
        amountClp: 500_000,
        fromMonth: "2024-01",
        toMonth: "2024-04",
      }),
      null
    );
    assert.equal(
      adjustRent({
        series: series(),
        amountClp: 500_000,
        fromMonth: "2023-11",
        toMonth: "2024-03",
      }),
      null
    );
  });

  test("refuses a backwards period", () => {
    assert.equal(
      adjustRent({
        series: series(),
        amountClp: 500_000,
        fromMonth: "2025-01",
        toMonth: "2024-01",
      }),
      null
    );
  });

  test("refuses an amount that is not a positive number", () => {
    for (const amountClp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        adjustRent({ series: series(), amountClp, fromMonth: "2024-01", toMonth: "2025-01" }),
        null
      );
    }
  });

  test("a zero-length period is a true answer, not an error", () => {
    const r = adjustRent({
      series: series(),
      amountClp: 500_000,
      fromMonth: "2024-01",
      toMonth: "2024-01",
    });
    assert.ok(r);
    assert.equal(r.accumulated, 0);
    assert.equal(r.adjustedClp, 500_000);
    assert.equal(r.differenceClp, 0);
  });

  test("deflation lowers the rent rather than being clamped away", () => {
    const s = parseIpcSeries(ok([obs("01-01-2024", "100"), obs("01-02-2024", "99")]));
    assert.ok(s);
    const r = adjustRent({
      series: s,
      amountClp: 500_000,
      fromMonth: "2024-01",
      toMonth: "2024-02",
    });
    assert.ok(r);
    assert.ok(r.differenceClp < 0);
    assert.equal(Math.round(r.adjustedClp), 495_000);
  });
});

describe("series helpers", () => {
  test("twelveMonthVariation uses the same month a year earlier", () => {
    const v = twelveMonthVariation(series());
    assert.ok(v);
    assert.equal(v.point.month, "2025-01");
    assert.ok(Math.abs(v.ratio - 0.05) < 1e-12);
  });

  test("twelveMonthVariation is null when the series cannot state one", () => {
    const s = parseIpcSeries(ok([obs("01-01-2025", "105")]));
    assert.ok(s);
    assert.equal(twelveMonthVariation(s), null);
  });

  test("availableMonths offers exactly the months that can be computed, newest first", () => {
    assert.deepEqual(availableMonths(series()), ["2025-01", "2024-03", "2024-02", "2024-01"]);
  });

  test("pointFor and latestPoint", () => {
    assert.equal(pointFor(series(), "2024-02")?.index, 101);
    assert.equal(pointFor(series(), "2024-04"), null);
    assert.equal(latestPoint(series()).month, "2025-01");
  });

  test("accumulatedVariation is reproducible by dividing the two published levels", () => {
    const v = accumulatedVariation(
      { month: "2024-01", index: 100 },
      { month: "2024-03", index: 102 }
    );
    assert.ok(Math.abs(v - 0.02) < 1e-12);
  });

  test("isMonthKey accepts real month keys only", () => {
    assert.equal(isMonthKey("2026-09"), true);
    assert.equal(isMonthKey("2026-13"), false);
    assert.equal(isMonthKey("2026-00"), false);
    assert.equal(isMonthKey("2026-9"), false);
    assert.equal(isMonthKey("2026-09-01"), false);
  });
});

/* -------------------------------------------------------------------------- */

describe("validated against the INE Calculadora IPC", () => {
  /**
   * The reason this suite exists.
   *
   * A reajuste is a number two parties put in a lease, so "close enough" is not a
   * standard. On 2026-09-09 every case below was run against the official INE calculator
   * at calculadoraipc.ine.cl - through the same public endpoint its own front end uses,
   * api-calculadora.ine.cl/ServiciosCalculadoraVariacion - and against this code, on the
   * published Banco Central index.
   *
   * The first run did NOT agree. The implementation was between $45 and $209 high on $650.000,
   * because it applied the raw quotient of two published index levels while INE applies
   * the OFFICIAL variation, which is published to one decimal. INE is explicit about this
   * on the calculator itself: the internal series carries twelve decimals, "la variación
   * presentada es a un decimal, ya que la variación oficial del índice también es a un
   * decimal", and the monetary adjustment follows the one-decimal figure.
   *
   * Adopting the same rule made all five agree exactly. These fixtures pin that, so a
   * future change to the rounding cannot silently reopen the gap.
   *
   * The residual, stated rather than hidden: INE derives its one-decimal variation from a
   * twelve-decimal internal series, and this library derives it from the two-decimal
   * published index. When the true variation sits almost exactly on a rounding boundary
   * the two could land on different tenths. That is why the interface presents the result
   * as the official variation applied to the amount, shows both index levels, and does not
   * claim to BE the INE calculator.
   */
  const index = (month: string, value: string) => obs(`01-${month}`, value);

  /** The published index levels for every month the validation touches. */
  const validationSeries = (): IpcSeries => {
    const parsed = parseIpcSeries(
      ok([
        index("01-2010", "57.61"),
        index("12-2018", "75.83"),
        index("08-2020", "79.22"),
        index("08-2025", "108.66"),
        index("07-2026", "112.45"),
        index("08-2026", "113.15"),
      ])
    );
    assert.ok(parsed);
    return parsed;
  };

  const RENT = 650_000;

  /** [label, from, to, INE variation %, INE adjusted CLP] - all captured from INE. */
  const CASES: [string, string, string, number, number][] = [
    ["one month", "2026-07", "2026-08", 0.6, 653_900],
    ["twelve months", "2025-08", "2026-08", 4.1, 676_650],
    ["multi-year, 72 months", "2020-08", "2026-08", 42.8, 928_200],
    ["across the 2018 base, 92 months", "2018-12", "2026-08", 49.2, 969_800],
    ["the full chained series, 199 months", "2010-01", "2026-08", 96.4, 1_276_600],
  ];

  for (const [label, fromMonth, toMonth, inePct, ineClp] of CASES) {
    test(`${label} matches INE to the peso`, () => {
      const r = adjustRent({
        series: validationSeries(),
        amountClp: RENT,
        fromMonth,
        toMonth,
      });
      assert.ok(r);
      assert.equal(
        Number((r.officialRatio * 100).toFixed(1)),
        inePct,
        "the official one-decimal variation must equal INE's"
      );
      assert.equal(Math.round(r.adjustedClp), ineClp, "the adjusted rent must equal INE's");
    });
  }

  test("the audit line keeps the raw quotient, which is what a reader can reproduce", () => {
    const r = adjustRent({
      series: validationSeries(),
      amountClp: RENT,
      fromMonth: "2025-08",
      toMonth: "2026-08",
    })!;
    // 113,15 ÷ 108,66 − 1 = 4,1322…%, the figure derived from the two visible levels.
    assert.ok(Math.abs(r.accumulated - 0.0413216) < 1e-6);
    // …while the money moves by the official 4,1%.
    assert.equal(r.officialRatio, 0.041);
  });
});

describe("officialVariation", () => {
  test("expresses a ratio to one decimal place as a percentage", () => {
    assert.equal(officialVariation(0.0413216), 0.041);
    assert.equal(officialVariation(0.006225), 0.006);
    assert.equal(officialVariation(0.964068), 0.964);
    assert.equal(officialVariation(0), 0);
  });

  test("rounds half away from zero, symmetrically for deflation", () => {
    assert.equal(officialVariation(0.0015), 0.002);
    assert.equal(officialVariation(-0.0015), -0.002);
  });

  test("is free of binary floating-point residue", () => {
    // 4.1 / 100 is 0.040999999999999995 unless the conversion is done carefully, and that
    // error reaches the peso figure.
    assert.equal(officialVariation(0.0413216) * 650_000, 26_650);
  });
});
