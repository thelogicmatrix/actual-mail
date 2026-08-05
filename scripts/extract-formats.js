// Developer tool. Saves one exemplar per transaction type into harvest-out/by-type/
// and prints just the sentence that carries the transaction, so formats can be derived
// from real mail without dumping 29KB of table markup per message.
import { ImapFlow } from 'imapflow';
import { convert } from 'html-to-text';
import { mkdir, writeFile } from 'node:fs/promises';

// Ordered: first match wins, so the "Overseas" variants must precede their generic forms.
const TYPES = [
  ['fx-card', 'Overseas transaction successful'],
  ['fx-cancel', 'Overseas transaction cancelled'],
  ['fx-refund', 'Overseas transaction refunded'],
  ['card', 'Transaction successful'],
  ['cancel', 'Transaction cancelled'],
  ['refund', 'Transaction refunded'],
  ['paynow-out', "Paynow transfer's a success"],
  ['paynow-in', 'received a PayNow transfer'],
  ['pot-transfer', 'Savings Pot transfer'],
  ['kaching-in', 'KACHING'],
  ['local-out', 'made a local transfer'],
  ['ignore-payee-added', 'New payee successfully added'],
  ['ignore-estatement', 'eStatement is ready'],
];

function classify(subject) {
  for (const [slug, needle] of TYPES) if (subject.includes(needle)) return slug;
  return null;
}

const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT), secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  logger: false,
});

await client.connect();
await client.mailboxOpen(process.env.IMAP_MAILBOX ?? 'INBOX');
await mkdir('harvest-out/by-type', { recursive: true });

const seen = new Map();
for await (const msg of client.fetch({ from: 'trustbank.sg' }, { envelope: true, source: true })) {
  const slug = classify(msg.envelope.subject ?? '');
  if (!slug || seen.has(slug)) continue;
  seen.set(slug, { source: msg.source, subject: msg.envelope.subject });
}
await client.logout();

for (const [slug, { source, subject }] of seen) {
  await writeFile(`harvest-out/by-type/${slug}.html`, source);
  const text = convert(source.toString('utf8'), { wordwrap: false });
  const lines = text.split('\n').map((l) => l.trim())
    .filter((l) => /SGD|S\$|[A-Z]{3}\s*[\d,]+\.\d{2}/.test(l))
    .filter((l) => !/Trust Bank Singapore Limited|Co\. Reg|Deposit Insurance/i.test(l));
  console.log(`\n### ${slug}  |  ${subject}`);
  for (const l of lines.slice(0, 4)) console.log('   ', l);
  if (lines.length === 0) console.log('    (no money line found - inspect manually)');
}
console.log(`\ncaptured ${seen.size}/${TYPES.length} types`);
