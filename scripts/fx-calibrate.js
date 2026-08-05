// Developer tool. Derives the FX markup from observed charges against ECB reference rates.
// Reports per-row markup AND its rounding uncertainty, because SGD charges are rounded to
// 2dp and on a small transaction that rounding swamps the signal.
// Observations live in harvest-out/ (gitignored) because they are real spending history
// and this repo is public. Format: [date, currency, foreignAmount, sgdCharged]
//   [["2026-01-01", "GBP", 10.00, 17.25], ...]
// Build the list from harvest-out/fx-calibration.csv after filling in what you were charged.
import { readFileSync } from 'node:fs';

const OBS_PATH = process.env.FX_OBS ?? 'harvest-out/fx-observations.json';
let OBS;
try {
  OBS = JSON.parse(readFileSync(OBS_PATH, 'utf8'));
} catch {
  console.error(`no observations at ${OBS_PATH}\n`
    + 'Run scripts/fx-report.js, fill SGD_CHARGED_fill in harvest-out/fx-calibration.csv,\n'
    + 'then write the rows to that JSON file as [date, currency, foreignAmount, sgdCharged].');
  process.exit(1);
}

const rates = new Map();
for (const date of new Set(OBS.map((o) => o[0]))) {
  const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=SGD`);
  const json = await res.json();
  rates.set(date, json);
}

console.log('date        cur   amount    ecb_rate    ecb_sgd  charged  markup%   +/-rounding');
console.log('-'.repeat(84));

let sumCharged = 0;
let sumEcb = 0;
const byCur = new Map();

for (const [date, cur, amount, charged] of OBS) {
  const json = rates.get(date);
  const ecbRate = 1 / json.rates[cur];
  const ecbSgd = amount * ecbRate;
  const markup = (charged / ecbSgd - 1) * 100;
  // A charge rounded to the nearest cent carries +/-0.005 SGD of ambiguity.
  const uncertainty = (0.005 / ecbSgd) * 100;

  sumCharged += charged;
  sumEcb += ecbSgd;
  if (!byCur.has(cur)) byCur.set(cur, { charged: 0, ecb: 0, n: 0 });
  const b = byCur.get(cur);
  b.charged += charged; b.ecb += ecbSgd; b.n += 1;

  console.log(
    `${date}  ${cur}  ${String(amount).padStart(7)}  ${ecbRate.toFixed(6).padStart(10)}  `
    + `${ecbSgd.toFixed(4).padStart(9)}  ${charged.toFixed(2).padStart(7)}  `
    + `${markup.toFixed(3).padStart(7)}  +/-${uncertainty.toFixed(2)}%`);
}

console.log('\n--- value-weighted (rounding averages out) ---');
console.log(`total charged  S$${sumCharged.toFixed(2)}`);
console.log(`total at ECB   S$${sumEcb.toFixed(2)}`);
console.log(`blended markup ${((sumCharged / sumEcb - 1) * 100).toFixed(3)}%`);

console.log('\n--- per currency (value-weighted) ---');
for (const [cur, b] of byCur) {
  console.log(`${cur}  n=${b.n}  charged S$${b.charged.toFixed(2)}  `
    + `ecb S$${b.ecb.toFixed(2)}  markup ${((b.charged / b.ecb - 1) * 100).toFixed(3)}%`);
}
