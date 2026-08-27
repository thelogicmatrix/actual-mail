// From row.js, not load.js: load.js imports THIS file, so taking it from there would be a
// dependency cycle through the money path. See Step 1.
import { toMinorUnits } from '../row.js';

// Two banks alerting on the same movement stamp the TRANSACTION time, not the send time, so
// the legs land within seconds of each other. Measured 2026-08-27: six bank-to-bank pairs
// matched to the exact minute, and one bank-to-Wise pair was 18.2 seconds apart.
//
// Two minutes rather than zero, and the Wise measurement is why. The banks print HH:MM with
// no seconds while the Wise API is exact to the millisecond, so truncation alone contributes
// up to 59 seconds before any settlement latency is counted. A zero-delta window would have
// failed on that seam outright.
//
// Send time is materially different and is deliberately NOT used: UOB's status mail for one
// transfer arrived 19 minutes after the event it describes.
export const WINDOW_MS = 2 * 60 * 1000;

// A payee that names one of your own accounts by its last four digits. Trust writes
// "A/C ending 0000" on a local transfer and UOB writes "TEST BANK a/c ending 0000" on a funds
// transfer, so in those cases ONE email describes both sides and no partner row is needed.
// This is the only path that can book the far side of a transfer whose receiving bank sends
// no alert at all, which UOB was verified to do on 2026-08-27.
const ACCT_IN_PAYEE = /a\/c ending (\d{4})/i;

export function namedAccount(row, mapping) {
  const m = ACCT_IN_PAYEE.exec(row.payee ?? '');
  // Only a key that is actually mapped counts. An unmapped four-digit group is somebody
  // else's account, not one of yours, and must stay an ordinary payee.
  return m && mapping[m[1]] ? m[1] : null;
}

// Two rows are the same movement of money when all five hold. See the design doc for the
// measurements behind each one.
function isPair(a, b, mapping) {
  const minor = toMinorUnits(a.amount);
  return a.id !== b.id
    // A zero row would satisfy the opposite-sign test against another zero row, because
    // `0 === -0` in JavaScript.
    && minor !== 0
    && a.currency === b.currency
    && minor === -toMinorUnits(b.amount)
    // RESOLVED account ids, not row keys. Several keys point at one Actual account in a real
    // mapping, so a key comparison books nonsense transfers inside a single account. An
    // unmapped account yields undefined on both sides and correctly fails this test.
    && mapping[a.account] !== undefined
    && mapping[a.account] !== mapping[b.account]
    && Math.abs(Date.parse(a.date) - Date.parse(b.date)) <= WINDOW_MS;
}

export function pairRows(rows, mapping) {
  // Pot moves already book as two-sided transfers through their own branch in loadRows.
  const eligible = rows.filter((r) => r.type !== 'pot_transfer');
  const candidates = new Map(
    eligible.map((a) => [a.id, eligible.filter((b) => isPair(a, b, mapping))]));

  const pairs = [];
  const paired = new Set();
  let ambiguous = 0;

  for (const a of eligible) {
    if (paired.has(a.id)) continue;
    const list = candidates.get(a.id);
    if (list.length === 0) continue;
    // Ambiguity is refused, never guessed. Uniqueness has to be MUTUAL: A having exactly one
    // candidate means nothing if that candidate has three, because then choosing A is a
    // coin toss that hides two real transactions.
    if (list.length > 1) { ambiguous += 1; continue; }
    const b = list[0];
    if (paired.has(b.id) || candidates.get(b.id).length !== 1) { ambiguous += 1; continue; }

    paired.add(a.id);
    paired.add(b.id);
    const out = toMinorUnits(a.amount) < 0 ? a : b;
    pairs.push({ out, into: out === a ? b : a });
  }

  return { pairs, ambiguous };
}
