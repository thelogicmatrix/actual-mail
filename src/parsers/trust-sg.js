import { makeRow } from '../row.js';

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

// Currency renders as "SGD 3.18" or "S$ 50.00"; amounts may carry thousands separators.
const AMT = String.raw`(S\$|[A-Z]{3})\s*([\d,]+\.\d{2})`;
// Time renders as "07:24SGT" or "12:33 SGT"; timezone is "SGT" on all but one observed
// message out of 439, which renders "GMT+08:00". (Counted over the maintainer's own mailbox;
// the harvest directory is gitignored, so that figure is not one a reader here can reproduce.)
const WHEN = String.raw`(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}:\d{2})\s*(?:SGT|GMT\+08:00)`;
const APOS = String.raw`['’]`;
// The card is named "Trust Link card" on most messages and plain "Trust card" on others.
const CARD = String.raw`(?:Link )?`;
const MONEY_TOKEN = /(?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2}/;

function isoDate(day, mon, year, hhmm) {
  const m = MONTHS[mon];
  if (!m) throw new RangeError(`unknown month: ${mon}`);
  return `${year}-${m}-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`;
}

const cur = (raw) => (raw === 'S$' ? 'SGD' : raw);
const money = (raw, negative) => (negative ? '-' : '') + raw.replaceAll(',', '');

// Card-shaped: currency=1, amount=2, payee=3, then date at 4..7.
function cardLike(source, type, negative) {
  return { re: new RegExp(source), build: (m, ref) => makeRow({
    source: 'trust', account: 'card', date: isoDate(m[4], m[5], m[6], m[7]),
    amount: money(m[2], negative), currency: cur(m[1]), payee: m[3].trim(),
    type, rawRef: ref }) };
}

// Transfer-shaped with an explicit source account: account=3, payee=4, date at 5..8.
function transferLike(source, type, negative) {
  return { re: new RegExp(source), build: (m, ref) => makeRow({
    source: 'trust', account: m[3], date: isoDate(m[5], m[6], m[7], m[8]),
    amount: money(m[2], negative), currency: cur(m[1]), payee: m[4].trim(),
    type, rawRef: ref }) };
}

// Inbound, no source account in the text: payee=3, date at 4..7.
function inboundLike(source, type) {
  return { re: new RegExp(source), build: (m, ref) => makeRow({
    source: 'trust', account: 'main', date: isoDate(m[4], m[5], m[6], m[7]),
    amount: money(m[2], false), currency: cur(m[1]), payee: m[3].trim(),
    type, rawRef: ref }) };
}

// Order matters for the three card word orders: the FX form ("using card at MERCHANT")
// first, then overseas-billed-in-SGD ("at MERCHANT with card on DATE"), then domestic
// ("at MERCHANT on DATE with card"). Each requires a full date immediately after the
// merchant capture, which is what stops a lazy (.+?) from stopping at an " on " inside a
// merchant name.
const PARSERS = [
  cardLike(String.raw`You${APOS}ve spent ${AMT} using Trust ${CARD}card at (.+?) on ${WHEN}`,
    'card', true),
  cardLike(String.raw`You${APOS}ve spent ${AMT} at (.+?) with Trust ${CARD}card on ${WHEN}`,
    'card', true),
  cardLike(String.raw`You${APOS}ve spent ${AMT} at (.+?) on ${WHEN} with Trust ${CARD}card`,
    'card', true),

  // Cancellations and refunds are POSITIVE: they offset an earlier authorisation. Neither
  // carries a reference to the original, so an offsetting row is the only correct shape.
  // Importing them negative would double-count the spend.
  cardLike(String.raw`We${APOS}ve cancelled your purchase of ${AMT} at (.+?) on ${WHEN}`,
    'cancel', false),
  cardLike(String.raw`We${APOS}ve refunded ${AMT} from (.+?) to your Trust card on ${WHEN}`,
    'refund', false),

  transferLike(
    String.raw`Your PayNow transfer of ${AMT} from A/C ending (\d{4}) to (.+?) on ${WHEN} is successful`,
    'transfer_out', true),
  transferLike(
    String.raw`A local transfer of ${AMT} from A/C ending (\d{4}) to (.+?) on ${WHEN} is successful`,
    'transfer_out', true),
  // Pot transfers run both ways. Both rows are written from the bank account's point of
  // view — account is always the A/C, payee is always the pot — so the pair nets to zero.
  transferLike(
    String.raw`Your Own Account Transfer of ${AMT} from A/C ending (\d{4}) to (.+?) on ${WHEN} is successful`,
    'pot_transfer', true),
  // Reverse direction: pot -> account, so account and payee swap position in the text.
  { re: new RegExp(
      String.raw`Your Own Account Transfer of ${AMT} from (.+?) to A/C ending (\d{4}) on ${WHEN} is successful`),
    build: (m, ref) => makeRow({
      source: 'trust', account: m[4], date: isoDate(m[5], m[6], m[7], m[8]),
      amount: money(m[2], false), currency: cur(m[1]), payee: m[3].trim(),
      type: 'pot_transfer', rawRef: ref }) },

  inboundLike(String.raw`You${APOS}ve received a PayNow transfer of ${AMT} from (.+?) on ${WHEN}`,
    'transfer_in'),
  inboundLike(String.raw`You${APOS}ve received a local transfer of ${AMT} from (.+?) on ${WHEN}`,
    'transfer_in'),
  inboundLike(String.raw`You have received ${AMT} from (.+?) on ${WHEN}`, 'transfer_in'),
];

// Subject patterns for known non-transactional mail. Checked only after every parser has
// failed, so a loose pattern here can never swallow a real transaction.
const IGNORE_SUBJECTS = [
  /eStatement is ready/i, /New payee/i, /registered for PayNow/i, /unregistered PayNow/i,
  /Google Wallet/i, /Card replaced/i, /biometric login/i, /Trust Key setup/i,
  /savings account is set up/i, /Welcome to Trust/i, /address updates/i,
  /interest rates/i, /plan change is confirmed/i, /payment settings have been updated/i,
  /Stocks account/i, /Trust Insure/i, /Protect Your Cash/i, /Job Scam/i,
  /UCITS ETFs/i, /Zero Commission/i, /PayNow nickname/i, /Guaranteed .* on savings/i,
  /^<ADV>/i,
];

export function parseTrust(text, rawRef, subject = '') {
  for (const p of PARSERS) {
    const m = p.re.exec(text);
    if (m) return p.build(m, rawRef);
  }
  if (IGNORE_SUBJECTS.some((re) => re.test(subject))) return { ignored: true, reason: 'subject' };
  // No money figure anywhere means this cannot be a transaction format we have missed.
  // Without this, every new marketing email would trip the run's non-zero exit.
  if (!MONEY_TOKEN.test(text)) return { ignored: true, reason: 'no-money-token' };
  return null;
}

// The registry contract. `from` is the IMAP FROM filter for this bank's alert mail.
// +08:00 and S$->SGD live inside this file deliberately: they are facts about how Trust
// writes its emails, not global configuration.
export default { id: 'trust-sg', from: 'trustbank.sg', parse: parseTrust };
