// Developer tool. Prints the transactional sentence from overseas emails that the
// current fx patterns fail to match, so the missing variant can be seen rather than guessed.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const W = String.raw`(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}:\d{2})\s*SGT`;
const A = String.raw`([A-Z]{3})\s*([\d,]+\.\d{2})`;
const KNOWN = [
  new RegExp(String.raw`You've spent ${A} using Trust Link card at (.+?) on ${W}`),
  new RegExp(String.raw`You've spent ${A} at (.+?) with Trust Link card on ${W}`),
  new RegExp(String.raw`We've cancelled your purchase of ${A} at (.+?) on ${W}`),
  new RegExp(String.raw`We've refunded ${A} from (.+?) to your Trust card on ${W}`),
];

const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT), secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  logger: false,
});

await client.connect();
await client.mailboxOpen(process.env.IMAP_MAILBOX ?? 'INBOX');

const shapes = new Map();
for await (const msg of client.fetch({ from: 'trustbank.sg' }, { envelope: true, source: true })) {
  const subject = msg.envelope.subject ?? '';
  if (!subject.toLowerCase().includes('overseas')) continue;

  const parsed = await simpleParser(msg.source);
  const text = (parsed.text ?? '').replace(/\s+/g, ' ').replace(/[’]/g, "'");
  if (KNOWN.some((re) => re.test(text))) continue;

  const line = text.split(/(?<=\.)\s+/)
    .find((s) => /[A-Z]{3}\s*[\d,]+\.\d{2}|SGD|S\$/.test(s)) ?? text.slice(0, 200);

  // Normalise to a shape so repeats collapse: digits -> 9, merchant words -> M
  const shape = line.replace(/[\d,]+\.\d{2}/g, 'N.NN').replace(/\b\d+\b/g, 'D').slice(0, 190);
  if (!shapes.has(shape)) shapes.set(shape, { example: line.trim().slice(0, 190), n: 0 });
  shapes.get(shape).n += 1;
}
await client.logout();

console.log(`\n${shapes.size} distinct unmatched shape(s):\n`);
for (const [, { example, n }] of shapes) console.log(`[${n}x] ${example}\n`);
