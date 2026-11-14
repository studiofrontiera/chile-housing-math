import { calculateMortgage, roundUf, ufToClp, roundClp, affordability } from "../src/index.ts";

// A 4,500 UF apartment, 20% down payment, 4.5% annual rate, 25 years.
const loan = calculateMortgage({ propertyUf: 4500, downPaymentUf: 900, annualRatePct: 4.5, termYears: 25 });
const ufValue = 39500; // pass today's UF; the library never invents one

const paymentClp = ufToClp(loan.monthlyPaymentUf, ufValue);
console.log(`Loan: ${roundUf(loan.loanUf)} UF (LTV ${(loan.loanToValue * 100).toFixed(0)}%)`);
console.log(`Monthly payment: ${roundUf(loan.monthlyPaymentUf)} UF, about CLP ${roundClp(paymentClp).toLocaleString("es-CL")} at today's UF`);
console.log(`Total interest: ${roundUf(loan.totalInterestUf)} UF`);

const a = affordability({ monthlyPaymentClp: paymentClp, netIncomeClp: 3_200_000 });
if (a) console.log(`Payment to income: ${(a.paymentToIncome * 100).toFixed(1)}% (reference ${a.targetRatio * 100}%)`);
