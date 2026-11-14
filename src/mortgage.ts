/**
 * Mortgage mathematics for Chile.
 *
 * This module is deliberately pure: no React, no formatting, no DOM, no I/O, no clock. It
 * takes numbers and returns numbers, which is what makes it testable - see
 * `test/mortgage.test.ts`. UI components must never re-implement any of this arithmetic;
 * if a screen needs a figure, it comes from here.
 *
 * Denomination. Chilean mortgages are written in UF, not pesos: the debt, the instalment
 * and the schedule are all UF quantities, and the peso amount is whatever that UF is worth
 * on the day it is paid. So UF is the canonical unit throughout, and conversion to pesos
 * happens once, at the edge, at a UF value the caller supplies. That is also why the
 * peso figures this module produces are explicitly "at today's UF" and not predictions:
 * the real peso cost of a 25-year loan depends on 300 future UF values nobody knows.
 */

/** How a quoted annual rate becomes a monthly rate. */
export type RateConvention =
  /** Nominal: monthly = annual / 12. What Chilean mortgage simulators generally use. */
  | "nominal"
  /** Effective: monthly = (1 + annual)^(1/12) − 1. Compounds to the quoted annual rate. */
  | "effective";

export type MortgageInput = {
  /** Property price in UF. */
  propertyUf: number;
  /** Down payment ("pie") in UF. */
  downPaymentUf: number;
  /** Quoted annual interest rate as a percentage, e.g. 4.5 for 4,5 %. */
  annualRatePct: number;
  /** Term in years. */
  termYears: number;
  /** Defaults to "nominal". */
  convention?: RateConvention;
};

export type ScheduleRow = {
  /** 1-based instalment number. */
  n: number;
  /** Interest portion of this instalment, UF. */
  interestUf: number;
  /** Principal portion of this instalment, UF. */
  principalUf: number;
  /** Debt still outstanding after this instalment, UF. */
  balanceUf: number;
};

export type MortgageResult = {
  propertyUf: number;
  downPaymentUf: number;
  /** Amount actually borrowed. */
  loanUf: number;
  /** Down payment as a share of the price, 0..1. */
  downPaymentRate: number;
  /** Loan as a share of the price, 0..1 - the LTV Chilean banks cap around 0.80–0.90. */
  loanToValue: number;
  /** The monthly rate actually used, as a fraction (not a percentage). */
  monthlyRate: number;
  /** Number of instalments. */
  months: number;
  /** The level instalment ("dividendo"), UF. Excludes insurance, taxes and fees. */
  monthlyPaymentUf: number;
  /** monthlyPaymentUf × months. */
  totalPaidUf: number;
  /** totalPaidUf − loanUf. */
  totalInterestUf: number;
};

export type Affordability = {
  /** Instalment ÷ net monthly income, 0..1. */
  paymentToIncome: number;
  /** (Instalment + existing obligations) ÷ net monthly income, 0..1. */
  totalBurdenToIncome: number;
  /** Net monthly income that would put the total burden at `targetRatio`. */
  requiredIncomeClp: number;
  /** What is left after the instalment and existing obligations. May be negative. */
  disposableClp: number;
  /** The reference ratio used. Indicative, never an approval rule. */
  targetRatio: number;
};

/**
 * The affordability reference. Chilean lenders commonly look for an instalment around a
 * quarter of net income; it is a rule of thumb for orientation, not a rule of approval,
 * and the UI must present it that way.
 */
export const REFERENCE_BURDEN_RATIO = 0.25;

/** Terms offered by Chilean lenders, in years. */
export const TERM_OPTIONS = [10, 15, 20, 25, 30] as const;

/** Converts a quoted annual percentage into the monthly rate actually applied. */
export function monthlyRateFrom(
  annualRatePct: number,
  convention: RateConvention = "nominal"
): number {
  const annual = annualRatePct / 100;
  if (annual === 0) return 0;
  return convention === "effective" ? Math.pow(1 + annual, 1 / 12) - 1 : annual / 12;
}

/**
 * The level instalment of an amortising loan.
 *
 * P = L · i / (1 − (1 + i)^−n), and P = L / n when i = 0 - the zero-rate case is not an
 * edge case to guard against but a real input (a 0 % promotional or family loan), and the
 * closed form divides by zero there, so it is handled explicitly rather than by accident.
 */
export function levelPayment(loan: number, monthlyRate: number, months: number): number {
  if (months <= 0) return 0;
  if (loan <= 0) return 0;
  if (monthlyRate === 0) return loan / months;
  return (loan * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
}

/** Runs the whole calculation. Pure; the same input always gives the same output. */
export function calculateMortgage(input: MortgageInput): MortgageResult {
  const propertyUf = Math.max(0, input.propertyUf);
  // A pie cannot exceed the price, and cannot be negative.
  const downPaymentUf = Math.min(Math.max(0, input.downPaymentUf), propertyUf);
  const loanUf = propertyUf - downPaymentUf;
  const months = Math.max(0, Math.round(input.termYears * 12));
  const monthlyRate = monthlyRateFrom(input.annualRatePct, input.convention);

  const monthlyPaymentUf = levelPayment(loanUf, monthlyRate, months);
  const totalPaidUf = monthlyPaymentUf * months;

  return {
    propertyUf,
    downPaymentUf,
    loanUf,
    downPaymentRate: propertyUf > 0 ? downPaymentUf / propertyUf : 0,
    loanToValue: propertyUf > 0 ? loanUf / propertyUf : 0,
    monthlyRate,
    months,
    monthlyPaymentUf,
    totalPaidUf,
    totalInterestUf: totalPaidUf - loanUf,
  };
}

/**
 * The full amortisation schedule, one row per instalment.
 *
 * The final balance is forced to exactly zero. Accumulating 360 floating-point
 * subtractions otherwise leaves a residue of a few millionths of a UF, and a schedule that
 * ends at "0,000001 UF outstanding" is wrong in the only way a schedule can be wrong.
 */
export function amortisationSchedule(result: MortgageResult): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = result.loanUf;

  for (let n = 1; n <= result.months; n++) {
    const interestUf = balance * result.monthlyRate;
    let principalUf = result.monthlyPaymentUf - interestUf;
    if (n === result.months) principalUf = balance;
    balance = balance - principalUf;
    if (n === result.months || balance < 1e-9) balance = 0;
    rows.push({ n, interestUf, principalUf, balanceUf: balance });
  }
  return rows;
}

export type YearRow = {
  year: number;
  interestUf: number;
  principalUf: number;
  /** Balance at the end of the year. */
  balanceUf: number;
};

/** The same schedule aggregated by year - what a chart and a summary table actually want. */
export function scheduleByYear(rows: ScheduleRow[]): YearRow[] {
  const years: YearRow[] = [];
  for (const row of rows) {
    const year = Math.ceil(row.n / 12);
    let bucket = years[year - 1];
    if (!bucket) {
      bucket = { year, interestUf: 0, principalUf: 0, balanceUf: 0 };
      years[year - 1] = bucket;
    }
    bucket.interestUf += row.interestUf;
    bucket.principalUf += row.principalUf;
    bucket.balanceUf = row.balanceUf;
  }
  return years;
}

/**
 * Affordability, in pesos, because incomes and existing debts are quoted in pesos.
 *
 * Returns null without an income: the calculator's core result must never depend on the
 * user disclosing what they earn.
 */
export function affordability({
  monthlyPaymentClp,
  netIncomeClp,
  otherDebtsClp = 0,
  targetRatio = REFERENCE_BURDEN_RATIO,
}: {
  monthlyPaymentClp: number;
  netIncomeClp: number | null;
  otherDebtsClp?: number;
  targetRatio?: number;
}): Affordability | null {
  if (netIncomeClp === null || !Number.isFinite(netIncomeClp) || netIncomeClp <= 0) {
    return null;
  }
  const debts = Math.max(0, otherDebtsClp);
  const burden = monthlyPaymentClp + debts;
  return {
    paymentToIncome: monthlyPaymentClp / netIncomeClp,
    totalBurdenToIncome: burden / netIncomeClp,
    requiredIncomeClp: targetRatio > 0 ? burden / targetRatio : 0,
    disposableClp: netIncomeClp - burden,
    targetRatio,
  };
}

/* ------------------------------------------------------------------ conversion */

/** UF → CLP at a given UF value. */
export const ufToClp = (uf: number, ufValue: number): number => uf * ufValue;

/** CLP → UF at a given UF value. Guards a zero/absent UF rather than returning Infinity. */
export const clpToUf = (clp: number, ufValue: number): number =>
  ufValue > 0 ? clp / ufValue : 0;

/* ------------------------------------------------------------------ rounding */

/**
 * Rounding is part of the contract, not a display detail: a dividendo shown as 15,18 UF
 * must be the same number the schedule sums to. Both helpers round half away from zero,
 * which is what a reader expects, rather than JavaScript's round-half-up-toward-+∞.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, decimals);
  const scaled = value * factor;
  const sign = scaled < 0 ? -1 : 1;
  // The epsilon absorbs binary representation error, so 1.005 rounds to 1.01 rather than
  // to 1.00 because it is really stored as 1.00499999999999989.
  return (sign * Math.round(Math.abs(scaled) + 1e-9)) / factor;
}

/** UF amounts are conventionally shown to two decimals. */
export const roundUf = (uf: number): number => roundTo(uf, 2);

/** Pesos are whole numbers. */
export const roundClp = (clp: number): number => Math.round(clp);
