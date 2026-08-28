import { makeRow } from '../row.js';

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

// UOB always writes a three-letter code, never a symbol, but the code is captured rather
// than assumed so a non-SGD account does not silently book as SGD.
const AMT = String.raw`([A-Z]{3}) ([\d,]+\.\d{2})`;
// The money shapes: "at 9:34AM SGT, 24 Mar 26". 12-hour clock, two-digit year.
const WHEN = String.raw`(\d{1,2}):(\d{2})(AM|PM) SGT, (\d{1,2}) (\w{3}) (\d{2})`;
// The ATM shape moves SGT to the end: "at 12:26PM 26 Aug 26, SGT". Same fields, same order,
// different marker position, so it needs its own fragment rather than an optional group.
const WHEN_ATM = String.raw`(\d{1,2}):(\d{2})(AM|PM) (\d{1,2}) (\w{3}) (\d{2}), SGT`;
const MONEY_TOKEN = /(?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2}/;

// A PayNow payee carries the counterparty's UEN suffix. "TEST MERCHANT SG (UEN ending 0000)"
// and "TEST MERCHANT SG" are the same merchant, so keeping the suffix would split one payee
// into two in Actual.
const UEN = /\s*\(UEN ending [^)]*\)$/;

// Two-digit year expanded with a hardcoded century. UOB has only ever sent these from 2026
// and a sliding window would be speculative complexity for a format that will not outlive
// the parser.
function isoDate(h12, minute, ampm, day, mon, yy) {
  const m = MONTHS[mon];
  if (!m) throw new RangeError(`unknown month: ${mon}`);
  // 12AM is 00 and 12PM is 12, which is why the modulo comes before the offset rather than
  // after. `Number(h12) + (ampm === 'PM' ? 12 : 0)` is the obvious form and turns 12:26PM
  // into 24:26 and 12:30AM into 12:30.
  const hour = (Number(h12) % 12) + (ampm === 'PM' ? 12 : 0);
  return `20${yy}-${m}-${String(day).padStart(2, '0')}`
    + `T${String(hour).padStart(2, '0')}:${minute}:00+08:00`;
}

const money = (raw) => '-' + raw.replaceAll(',', '');

// Outbound with an explicit counterparty: currency=1, amount=2, payee=3, account=4, date 5..10.
function outLike(source, type) {
  return { re: new RegExp(source), build: (m, ref) => makeRow({
    source: 'uob', account: m[4], date: isoDate(m[5], m[6], m[7], m[8], m[9], m[10]),
    amount: money(m[2]), currency: m[1], payee: m[3].trim().replace(UEN, ''),
    type, rawRef: ref }) };
}

const PARSERS = [
  // Each payee capture is immediately followed by a fixed account clause, which is what stops
  // a lazy (.+?) running past a counterparty name containing " on " or " from ".
  // "made/scheduled" is UOB's own generic template wording, and it means this parser cannot
  // tell an executed transfer from a scheduled one. Not fixable here: the text carries no
  // second date and no status field to read.
  //
  // Measured over the 30-message sample, all six historical funds transfers were executed
  // immediately rather than scheduled. Each one has a Trust credit alert stamped to the same
  // minute, so no scheduled instance has ever been observed.
  //
  // The unhandled case, if it ever occurs: a transfer scheduled on the 24th for value on the
  // 1st is written with the scheduling timestamp as its date, and a later cancellation produces
  // no alert this parser can see, because the "is successful" status mail carries no amount and
  // is ignored by the no-money-token fallback. The budget would then hold spend that never
  // happened, with no offsetting row and no UNPARSED signal to notice it by.
  //
  // A second observed limitation, recorded here because it has the same shape. Three PayNow
  // transfers from March and April have only a status mail, with no amount-bearing sibling,
  // whereas the 27 August one has both. UOB's amount-bearing PayNow alert is evidently newer
  // than the account, so a PayNow made before that change produces no row at all. All three
  // are below the reconciliation floor and would be skipped regardless, so this needs no code.
  // The note exists so that a gap in the row set is not read as a parser bug.
  outLike(String.raw`You made/scheduled a funds transfer\(s\) of ${AMT} to (.+?) from your a/c ending (\d{4}) at ${WHEN}`,
    'transfer_out'),
  outLike(String.raw`You made a PayNow transfer of ${AMT} to (.+?) on your a/c ending (\d{4}) at ${WHEN}`,
    'transfer_out'),
  outLike(String.raw`You made a NETS QR payment of ${AMT} to (.+?) on your a/c ending (\d{4}) at ${WHEN}`,
    'nets_qr'),

  // No counterparty in the text, and the timezone marker trails the date.
  { re: new RegExp(String.raw`An ATM cash withdrawal of ${AMT} was made on your UOB account ending with (\d{4}) at ${WHEN_ATM}`),
    build: (m, ref) => makeRow({
      source: 'uob', account: m[3], date: isoDate(m[4], m[5], m[6], m[7], m[8], m[9]),
      amount: money(m[2]), currency: m[1], payee: 'ATM cash withdrawal',
      type: 'atm', rawRef: ref }) },
];

// Checked only AFTER every transaction pattern has failed, so a loose pattern here can never
// swallow a real transaction.
const IGNORE_SUBJECTS = [
  /eStatement\/eAdvice/i,
  // A one-off welcome notice, not a per-spend alert. See test/uob.test.js for why this is
  // ignored rather than parsed.
  /First transaction made on your card/i,
];

export function parseUob(text, rawRef, subject = '') {
  for (const p of PARSERS) {
    const m = p.re.exec(text);
    if (m) return p.build(m, rawRef);
  }
  if (IGNORE_SUBJECTS.some((re) => re.test(subject))) return { ignored: true, reason: 'subject' };
  // Covers the FAST and PayNow "is successful" status mails and the payee-added notice. All
  // three are status confirmations of a movement already reported with its amount, and none
  // of them contains an amount at all, so there is nothing here to lose.
  if (!MONEY_TOKEN.test(text)) return { ignored: true, reason: 'no-money-token' };
  return null;
}

// The registry contract. `from` is the alert sender's LOCAL PART, deliberately, and not the
// full address: the full address is an email-address token, which is a finding under the
// email-address rule in scripts/scan-pii.js, and a tracked file carrying one would be written
// permanently into history by that gate's --all-revs pass. The local part matches the same
// single sender, verified against the live mailbox as the identical 30 messages. Do not
// "fix" this back to a full address without reading that gate first.
//
// It is the sender rather than the uobgroup.com domain because apply@, UOBSDeviceAlert@ and
// UOBDigital@ share that domain and send no transactions. The local part keeps that precision
// and travels further: Gmail token-matches it, and an IMAP server doing substring matching on
// the raw From header finds it inside the full address either way.
//
// +08:00 and the 12-hour clock live in this file because they are facts about how UOB writes
// its emails, not global configuration.
export default { id: 'uob-sg', from: 'unialerts', parse: parseUob };
