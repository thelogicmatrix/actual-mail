// Developer tool. Saves exemplars of the two card-spend variants that subject-based
// classification cannot distinguish: overseas billed in SGD ("at MERCHANT with card on DATE")
// and the lone GMT+08:00 timezone rendering. Both share the subject of another variant.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { mkdir, writeFile } from 'node:fs/promises';

const WANT = [
  ['card-overseas-sgd', (t) => /spent (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} at .+? with Trust Link card on/.test(t)
    && /SGT\.?$|SGT/.test(t)],
  ['card-overseas-gmt', (t) => /GMT\+08:00/.test(t)],
];

const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT), secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  logger: false,
});

await client.connect();
await client.mailboxOpen(process.env.IMAP_MAILBOX ?? 'INBOX');
await mkdir('harvest-out/by-type', { recursive: true });

const found = new Set();
for await (const msg of client.fetch({ from: 'trustbank.sg' }, { envelope: true, source: true })) {
  if (found.size === WANT.length) break;
  const parsed = await simpleParser(msg.source);
  const text = (parsed.text ?? '').replace(/\s+/g, ' ');
  for (const [slug, match] of WANT) {
    if (found.has(slug) || !match(text)) continue;
    await writeFile(`harvest-out/by-type/${slug}.html`, msg.source);
    found.add(slug);
    console.log(`saved ${slug}  <-  ${msg.envelope.subject}`);
  }
}
await client.logout();

for (const [slug] of WANT) if (!found.has(slug)) console.log(`MISSING ${slug}`);
