import { createHash } from 'node:crypto';

// The NUL separator matters: without it, ('tru','stx') and ('trust','x')
// would hash identically. Written as the two-character escape `\0`, NOT as a literal NUL byte:
// a raw NUL made this file binary to git, so `git log -p -- src/row.js` printed "Binary files
// differ" and the most safety-critical function in the tool was unreviewable in a PR diff — in a
// repo whose stated argument (src/parsers/index.js) is that a change "shows up in a PR diff".
// The escape is the identical byte, and test/row.test.js pins the resulting hash against the id
// published in the tutorial, because changing the separator's VALUE would change every
// imported_id and re-import the entire budget as new spend.
//
// `account` joined the identity because a source reference alone is not unique: a Wise balance
// conversion appears in BOTH balance statements under one referenceNumber, so with two balances
// mapped to one Actual account, one leg deduped against the other and vanished — counted as
// `alreadyPresent`, which reads as healthy. Called with two arguments it reproduces the
// pre-account id, which is what loadRows checks against so nothing already imported comes back.
export function rowId(source, rawRef, account = null) {
  const base = `${source}\0${rawRef}`;
  return createHash('sha256').update(account === null ? base : `${base}\0${account}`).digest('hex');
}

export function makeRow({ source, account, date, amount, currency, payee, type, rawRef }) {
  if (typeof amount !== 'string') throw new TypeError('amount must be a string');
  // Every row needs a stable reference, because the id derived from it is the only thing stopping
  // a transaction being imported twice. A Wise entry without a `referenceNumber` — a fee line, an
  // interest credit — hashed `wise\0undefined` along with every other such entry, so the first was
  // imported and each later one was counted as already-present and silently lost. The IMAP path
  // already threw on a missing Message-ID; this puts the same guarantee where every source, present
  // and future, has to pass through it.
  if (!rawRef) {
    throw new TypeError(`${source}: rawRef is required — a row with no stable reference cannot be deduped`);
  }
  return {
    id: rowId(source, rawRef, account),
    source, account, date, amount, currency, payee, type,
    raw_ref: rawRef,
  };
}

export const COLUMNS = ['id', 'source', 'account', 'date', 'amount', 'currency', 'payee', 'type', 'raw_ref'];

// Here rather than in load/load.js, which is where it used to live: load.js imports
// load/transfers.js, and transfers.js needs this, so leaving it there was a dependency cycle
// through the money path. This file is the right home regardless — it already owns the rule
// that an amount is a decimal string and throws on a number, so converting that string to
// minor units is the same concern, and this file imports nothing from load/.
export function toMinorUnits(decimalString) {
  const negative = decimalString.startsWith('-');
  const [whole, frac = '0'] = decimalString.replace('-', '').split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return negative ? -minor : minor;
}
