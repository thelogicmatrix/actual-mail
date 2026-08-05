// Developer tool. Extracts every overseas Trust transaction and pairs it with the ECB
// reference rate for its date, so the FX markup can be calibrated from many observations
// instead of one. Writes harvest-out/fx-report.csv for annotation.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { mkdir, writeFile } from 'node:fs/promises';

const AMT = String.raw`([A-Z]{3})\s*([\d,]+\.\d{2})`;
const WHEN = String.raw`(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}:\d{2})\s*SGT`;
const APOS = String.raw`['’]`;

// Three word orders, confirmed against live mail 2026-07-28. "using card at MERCHANT"
// carries a foreign currency; "at MERCHANT with card" is already billed in SGD.
const PATTERNS = [
  ['spend-fx', new RegExp(String.raw`You${APOS}ve spent ${AMT} using Trust Link card at (.+?) on ${WHEN}`)],
  ['spend-sgd', new RegExp(String.raw`You${APOS}ve spent ${AMT} at (.+?) with Trust Link card on ${WHEN}`)],
  ['cancel', new RegExp(String.raw`We${APOS}ve cancelled your purchase of ${AMT} at (.+?) on ${WHEN}`)],
  ['refund', new RegExp(String.raw`We${APOS}ve refunded ${AMT} from (.+?) to your Trust card on ${WHEN}`)],
];

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT), secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  logger: false,
});

await client.connect();
await client.mailboxOpen(process.env.IMAP_MAILBOX ?? 'INBOX');

const rows = [];
const unmatched = [];
for await (const msg of client.fetch({ from: 'trustbank.sg' }, { envelope: true, source: true })) {
  const subject = msg.envelope.subject ?? '';
  if (!subject.toLowerCase().includes('overseas')) continue;

  const parsed = await simpleParser(msg.source);
  const text = (parsed.text ?? '').replace(/\s+/g, ' ');

  let hit = null;
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) { hit = { kind, m }; break; }
  }
  if (!hit) { unmatched.push(subject); continue; }

  const [, cur, amt, merchant, d, mon, y] = hit.m;
  rows.push({
    kind: hit.kind,
    date: `${y}-${MONTHS[mon]}-${String(d).padStart(2, '0')}`,
    currency: cur,
    amount: Number(amt.replaceAll(',', '')),
    merchant: merchant.replace(/\s+/g, ' ').trim().slice(0, 45),
  });
}
await client.logout();

// One ECB call per distinct date; SGD-based so every currency comes back at once.
const rateCache = new Map();
for (const date of new Set(rows.map((r) => r.date))) {
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=SGD`);
    const json = await res.json();
    rateCache.set(date, { rates: json.rates, rateDate: json.date });
  } catch {
    rateCache.set(date, null);
  }
}

rows.sort((a, b) => a.date.localeCompare(b.date));

const header = 'date,kind,currency,foreign_amount,merchant,ecb_rate,ecb_rate_date,sgd_at_ecb,sgd_charged_FILL_ME,implied_rate,markup_pct';
const lines = [header];

console.log('\ndate        kind    cur  amount     ecb_rate   sgd@ecb  merchant');
console.log('-'.repeat(88));

for (const r of rows) {
  const entry = rateCache.get(r.date);
  const inv = entry?.rates?.[r.currency];
  const rate = inv ? 1 / inv : null;              // FOREIGN -> SGD
  const sgd = rate ? r.amount * rate : null;
  const rateStr = rate ? rate.toFixed(4) : 'n/a';
  const sgdStr = sgd ? sgd.toFixed(2) : 'n/a';

  console.log(
    `${r.date}  ${r.kind.padEnd(7)} ${r.currency}  ${String(r.amount).padStart(9)}  `
    + `${rateStr.padStart(8)}  ${sgdStr.padStart(8)}  ${r.merchant}`);

  lines.push([r.date, r.kind, r.currency, r.amount, `"${r.merchant.replaceAll('"', '""')}"`,
    rateStr, entry?.rateDate ?? '', sgdStr, '', '', ''].join(','));
}

await mkdir('harvest-out', { recursive: true });
await writeFile('harvest-out/fx-report.csv', lines.join('\n') + '\n');

const byCur = new Map();
for (const r of rows) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + 1);

console.log(`\n${rows.length} overseas transactions`);
console.log('by currency:', [...byCur].map(([c, n]) => `${c}=${n}`).join(' '));
console.log('by kind:', ['spend', 'cancel', 'refund']
  .map((k) => `${k}=${rows.filter((r) => r.kind === k).length}`).join(' '));
if (unmatched.length) console.log(`\nUNMATCHED (${unmatched.length}):`, [...new Set(unmatched)]);
console.log('\nwrote harvest-out/fx-report.csv');
