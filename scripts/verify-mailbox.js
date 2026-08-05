// Developer tool. The unit tests prove 13 shapes; this proves the parser handles every
// message actually in the mailbox. A non-empty `unparsed` is a missing format — add a
// parser for it rather than widening an ignore pattern.
import { fetchMessages } from '../src/imap.js';
import { parseTrust } from '../src/parsers/trust-sg.js';

let rows = 0;
const ignoredBy = new Map();
const unparsed = [];
const byType = new Map();

for await (const m of fetchMessages({
  host: process.env.IMAP_HOST, port: process.env.IMAP_PORT,
  user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD,
  mailbox: process.env.IMAP_MAILBOX, from: 'trustbank.sg',
})) {
  const r = parseTrust(m.text, m.messageId, m.subject);
  if (r === null) {
    unparsed.push(m.subject);
  } else if (r.ignored) {
    ignoredBy.set(r.reason, (ignoredBy.get(r.reason) ?? 0) + 1);
  } else {
    rows += 1;
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    if (!/^-?\d+\.\d{2}$/.test(r.amount)) console.log('BAD AMOUNT', r.amount, m.subject);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(r.date)) console.log('BAD DATE', r.date);
  }
}

console.log(`parsed   ${rows}`);
console.log('by type ', Object.fromEntries(byType));
console.log('ignored ', Object.fromEntries(ignoredBy));
console.log(`unparsed ${unparsed.length}`);
for (const s of new Set(unparsed)) console.log('   UNPARSED:', s);
