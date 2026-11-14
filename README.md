# chile-housing-math

Small, tested TypeScript library for the numbers behind buying or renting a home in Chile:

- **Mortgages in UF**: level payment ("dividendo"), loan-to-value, total interest, full amortisation schedule and a yearly summary.
- **Affordability**: payment-to-income and total burden against the common 25% reference (an orientation, never an approval rule).
- **Rent adjustment by IPC** ("reajuste de arriendo"): adjusts an amount between two months using the official monthly IPC, and matches the official INE calculator to the peso on five validated cases.
- **Banco Central de Chile client**: fetches the IPC series from the BDE REST API with your own token, and returns `null` instead of guessing when the service fails.

No runtime dependencies. Pure functions, no clock and no I/O outside `src/client.ts`.

## Why it exists

I built these modules for a bilingual real estate web platform in Chile and extracted them here as a standalone library. Two details make Chilean housing math easy to get wrong:

1. **Mortgages are written in UF, not pesos.** The library keeps UF as the canonical unit and converts to pesos once, at a UF value you supply. Peso figures are "at today's UF", not forecasts.
2. **INE adjusts money by the official variation rounded to one decimal**, not by the raw ratio of two index levels. Using the raw ratio is off by roughly $45 to $209 on a $650,000 rent. The tests pin the official rule.

## Quick start

Requires Node.js 22.6 or newer (runs TypeScript directly).

```bash
git clone https://github.com/<owner>/chile-housing-math
cd chile-housing-math
npm test          # 65 tests
npm run example
```

```ts
import { calculateMortgage, amortisationSchedule, roundUf } from "./src/index.ts";

const loan = calculateMortgage({
  propertyUf: 4500,
  downPaymentUf: 900,
  annualRatePct: 4.5,
  termYears: 25,
});

roundUf(loan.monthlyPaymentUf); // 20.01 UF
roundUf(loan.totalInterestUf);  // 2402.99 UF
amortisationSchedule(loan).length; // 300 rows, final balance exactly 0
```

Rent adjustment with the official index:

```ts
import { fetchIpcSeries, adjustRent } from "./src/index.ts";

const series = await fetchIpcSeries({ token: process.env.BCCH_API_TOKEN! });
if (series) {
  const r = adjustRent({ series, amountClp: 650_000, fromMonth: "2025-01", toMonth: "2026-01" });
  // r.officialRatio, r.adjustedClp, plus both index points so anyone can check the result
}
```

A free Banco Central API token is available from the [BDE web services page](https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/index.htm).

## Design choices

- **No fallback data.** If the Banco Central API does not answer, functions return `null`. A hand-maintained price index would be a guess used to change what someone pays in rent.
- **Zero-rate loans are a real input**, handled explicitly instead of dividing by zero.
- **Rounding is part of the contract**: half away from zero, with a guard for binary representation error, so the payment shown is the same number the schedule sums to.
- **Chilean calendar day**: date windows use `America/Santiago`, because Banco Central publishes the UF in advance and a UTC date can already be tomorrow in Chile.

## Project layout

```
src/mortgage.ts    mortgage, schedule, affordability, UF conversion, rounding
src/ipc-parse.ts   IPC parsing, variation and rent adjustment
src/ipc-types.ts   shared types
src/bcch.ts        Banco Central BDE REST helpers
src/client.ts      network fetch (token passed in)
test/              node:test suites
```

## Disclaimer

Indicative calculations for orientation only. Not financial, legal or tax advice. Bank offers include insurance, fees and taxes not modelled here.

## License

MIT
