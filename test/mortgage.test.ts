import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  affordability,
  amortisationSchedule,
  calculateMortgage,
  clpToUf,
  levelPayment,
  monthlyRateFrom,
  roundClp,
  roundTo,
  roundUf,
  scheduleByYear,
  ufToClp,
  REFERENCE_BURDEN_RATIO,
  TERM_OPTIONS,
} from "../src/mortgage.ts";

/**
 * Run with: npm test  (node --test, no test framework dependency - Node strips the types).
 *
 * These tests exist because the calculator makes a claim about somebody's money. Each one
 * pins a property that must hold rather than a snapshot of today's output, so the suite
 * still means something after the UI changes.
 */

const close = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "value"}: expected ${expected} ± ${tol}, got ${actual}`
  );

describe("monthlyRateFrom", () => {
  test("nominal divides the quoted annual rate by twelve", () => {
    close(monthlyRateFrom(4.8, "nominal"), 0.004, 1e-12);
  });

  test("effective compounds back to the quoted annual rate", () => {
    const m = monthlyRateFrom(4.5, "effective");
    close(Math.pow(1 + m, 12) - 1, 0.045, 1e-12, "compounded");
  });

  test("zero is zero under both conventions", () => {
    assert.equal(monthlyRateFrom(0, "nominal"), 0);
    assert.equal(monthlyRateFrom(0, "effective"), 0);
  });

  test("nominal is the default", () => {
    assert.equal(monthlyRateFrom(6), monthlyRateFrom(6, "nominal"));
  });
});

describe("levelPayment", () => {
  test("matches the closed form for a normal rate", () => {
    // 2.400 UF at 4,5 % nominal over 20 years.
    const p = levelPayment(2400, 0.045 / 12, 240);
    close(p, 15.1837, 0.001, "dividendo");
  });

  test("zero interest divides the principal evenly", () => {
    const p = levelPayment(2400, 0, 240);
    close(p, 10, 1e-12, "dividendo at 0 %");
    // And the loan is then repaid exactly, with no interest anywhere.
    close(p * 240, 2400, 1e-9, "total paid at 0 %");
  });

  test("a loan of nothing costs nothing", () => {
    assert.equal(levelPayment(0, 0.004, 240), 0);
  });

  test("a longer term lowers the instalment but raises the total", () => {
    const rate = 0.045 / 12;
    const short = levelPayment(2400, rate, 180);
    const long = levelPayment(2400, rate, 360);
    assert.ok(long < short, "30-year instalment must be below the 15-year one");
    assert.ok(long * 360 > short * 180, "but the 30-year total must be higher");
  });
});

describe("calculateMortgage", () => {
  const base = {
    propertyUf: 3000,
    downPaymentUf: 600, // 20 %
    annualRatePct: 4.5,
    termYears: 20,
  };

  test("derives the loan, the ratios and the totals", () => {
    const r = calculateMortgage(base);
    assert.equal(r.loanUf, 2400);
    close(r.downPaymentRate, 0.2, 1e-12, "pie share");
    close(r.loanToValue, 0.8, 1e-12, "LTV");
    assert.equal(r.months, 240);
    close(r.monthlyPaymentUf, 15.1837, 0.001, "dividendo");
    close(r.totalPaidUf, 15.1837 * 240, 0.3, "total paid");
    close(r.totalInterestUf, r.totalPaidUf - 2400, 1e-9, "interest is total minus loan");
  });

  test("total interest is positive at a positive rate and zero at 0 %", () => {
    assert.ok(calculateMortgage(base).totalInterestUf > 0);
    const free = calculateMortgage({ ...base, annualRatePct: 0 });
    close(free.totalInterestUf, 0, 1e-9, "interest at 0 %");
    close(free.monthlyPaymentUf, 2400 / 240, 1e-12, "dividendo at 0 %");
  });

  test("a larger down payment lowers the instalment and the interest", () => {
    const small = calculateMortgage({ ...base, downPaymentUf: 300 });
    const large = calculateMortgage({ ...base, downPaymentUf: 900 });
    assert.ok(large.monthlyPaymentUf < small.monthlyPaymentUf);
    assert.ok(large.totalInterestUf < small.totalInterestUf);
    close(large.loanToValue, 0.7, 1e-12, "LTV at 30 % pie");
  });

  test("paying cash leaves no loan, no instalment and no interest", () => {
    const r = calculateMortgage({ ...base, downPaymentUf: 3000 });
    assert.equal(r.loanUf, 0);
    assert.equal(r.monthlyPaymentUf, 0);
    assert.equal(r.totalInterestUf, 0);
    close(r.loanToValue, 0, 1e-12, "LTV");
  });

  test("a down payment above the price is clamped, never negative debt", () => {
    const r = calculateMortgage({ ...base, downPaymentUf: 5000 });
    assert.equal(r.downPaymentUf, 3000);
    assert.equal(r.loanUf, 0);
  });

  test("a negative down payment is clamped to zero", () => {
    const r = calculateMortgage({ ...base, downPaymentUf: -100 });
    assert.equal(r.downPaymentUf, 0);
    assert.equal(r.loanUf, 3000);
  });

  test("every offered term produces a finite, positive instalment", () => {
    for (const years of TERM_OPTIONS) {
      const r = calculateMortgage({ ...base, termYears: years });
      assert.equal(r.months, years * 12);
      assert.ok(Number.isFinite(r.monthlyPaymentUf), `${years}y finite`);
      assert.ok(r.monthlyPaymentUf > 0, `${years}y positive`);
      assert.ok(r.totalInterestUf > 0, `${years}y interest`);
    }
  });

  test("the instalment falls monotonically as the term lengthens", () => {
    const payments = TERM_OPTIONS.map(
      (years) => calculateMortgage({ ...base, termYears: years }).monthlyPaymentUf
    );
    for (let i = 1; i < payments.length; i++) {
      assert.ok(payments[i] < payments[i - 1], `${TERM_OPTIONS[i]}y below previous`);
    }
  });

  test("the effective convention costs slightly less than the nominal one", () => {
    const nominal = calculateMortgage({ ...base, convention: "nominal" });
    const effective = calculateMortgage({ ...base, convention: "effective" });
    assert.ok(effective.monthlyPaymentUf < nominal.monthlyPaymentUf);
    // Same order of magnitude - this guards against picking the wrong formula entirely.
    close(effective.monthlyPaymentUf, nominal.monthlyPaymentUf, 0.5, "convention gap");
  });
});

describe("amortisationSchedule", () => {
  const r = calculateMortgage({
    propertyUf: 3000,
    downPaymentUf: 600,
    annualRatePct: 4.5,
    termYears: 20,
  });
  const rows = amortisationSchedule(r);

  test("has one row per instalment", () => {
    assert.equal(rows.length, 240);
    assert.equal(rows[0].n, 1);
    assert.equal(rows[239].n, 240);
  });

  test("ends at exactly zero, not at a floating-point residue", () => {
    assert.equal(rows[rows.length - 1].balanceUf, 0);
  });

  test("the balance never increases and never goes negative", () => {
    let previous = r.loanUf;
    for (const row of rows) {
      assert.ok(row.balanceUf <= previous + 1e-9, `row ${row.n} did not decrease`);
      assert.ok(row.balanceUf >= 0, `row ${row.n} went negative`);
      previous = row.balanceUf;
    }
  });

  test("principal repaid over the whole schedule equals the loan", () => {
    const principal = rows.reduce((a, row) => a + row.principalUf, 0);
    close(principal, r.loanUf, 1e-6, "sum of principal");
  });

  test("interest charged over the schedule equals the reported total", () => {
    const interest = rows.reduce((a, row) => a + row.interestUf, 0);
    close(interest, r.totalInterestUf, 0.01, "sum of interest");
  });

  test("interest falls and principal rises across the term", () => {
    assert.ok(rows[0].interestUf > rows[239].interestUf);
    assert.ok(rows[0].principalUf < rows[239].principalUf);
  });

  test("at 0 % every instalment is pure principal", () => {
    const free = calculateMortgage({
      propertyUf: 1000,
      downPaymentUf: 0,
      annualRatePct: 0,
      termYears: 10,
    });
    const freeRows = amortisationSchedule(free);
    for (const row of freeRows) assert.equal(row.interestUf, 0);
    assert.equal(freeRows[freeRows.length - 1].balanceUf, 0);
    close(freeRows[0].principalUf, 1000 / 120, 1e-9, "principal per instalment");
  });

  test("aggregating by year preserves the totals", () => {
    const years = scheduleByYear(rows);
    assert.equal(years.length, 20);
    assert.equal(years[19].balanceUf, 0);
    close(
      years.reduce((a, y) => a + y.principalUf, 0),
      r.loanUf,
      1e-6,
      "principal by year"
    );
    close(
      years.reduce((a, y) => a + y.interestUf, 0),
      r.totalInterestUf,
      0.01,
      "interest by year"
    );
  });
});

describe("UF / CLP conversion", () => {
  test("round-trips", () => {
    const uf = 15.1837;
    close(clpToUf(ufToClp(uf, 39500), 39500), uf, 1e-9, "round trip");
  });

  test("converts a dividendo into pesos", () => {
    close(ufToClp(15.1837, 39500), 599756.15, 0.01, "dividendo in CLP");
  });

  test("an absent UF value yields zero rather than Infinity", () => {
    assert.equal(clpToUf(1_000_000, 0), 0);
    assert.ok(Number.isFinite(clpToUf(1_000_000, 0)));
  });
});

describe("rounding", () => {
  test("rounds half away from zero", () => {
    assert.equal(roundTo(1.005, 2), 1.01);
    assert.equal(roundTo(2.675, 2), 2.68);
    assert.equal(roundTo(-1.005, 2), -1.01);
    assert.equal(roundTo(0.5, 0), 1);
    assert.equal(roundTo(-0.5, 0), -1);
  });

  test("UF keeps two decimals and CLP is whole", () => {
    assert.equal(roundUf(15.18374), 15.18);
    assert.equal(roundUf(15.18574), 15.19);
    assert.equal(roundClp(599754.6), 599755);
    assert.equal(roundClp(599754.4), 599754);
  });

  test("non-finite input degrades to zero instead of NaN reaching the screen", () => {
    assert.equal(roundTo(Number.NaN, 2), 0);
    assert.equal(roundTo(Number.POSITIVE_INFINITY, 2), 0);
  });
});

describe("affordability", () => {
  const payment = 600_000;

  test("is null without an income - the result never depends on disclosing it", () => {
    assert.equal(affordability({ monthlyPaymentClp: payment, netIncomeClp: null }), null);
    assert.equal(affordability({ monthlyPaymentClp: payment, netIncomeClp: 0 }), null);
  });

  test("computes the ratios, the required income and what is left", () => {
    const a = affordability({
      monthlyPaymentClp: payment,
      netIncomeClp: 2_400_000,
      otherDebtsClp: 200_000,
    })!;
    close(a.paymentToIncome, 0.25, 1e-12, "payment ratio");
    close(a.totalBurdenToIncome, 800_000 / 2_400_000, 1e-12, "burden ratio");
    close(a.requiredIncomeClp, 800_000 / REFERENCE_BURDEN_RATIO, 1e-6, "required income");
    assert.equal(a.disposableClp, 1_600_000);
    assert.equal(a.targetRatio, REFERENCE_BURDEN_RATIO);
  });

  test("existing debts raise the required income", () => {
    const without = affordability({ monthlyPaymentClp: payment, netIncomeClp: 2_000_000 })!;
    const with_ = affordability({
      monthlyPaymentClp: payment,
      netIncomeClp: 2_000_000,
      otherDebtsClp: 300_000,
    })!;
    assert.ok(with_.requiredIncomeClp > without.requiredIncomeClp);
    assert.ok(with_.disposableClp < without.disposableClp);
  });

  test("reports a negative disposable rather than hiding it", () => {
    const a = affordability({
      monthlyPaymentClp: 1_500_000,
      netIncomeClp: 1_200_000,
    })!;
    assert.ok(a.disposableClp < 0);
    assert.ok(a.totalBurdenToIncome > 1);
  });
});
