// Developer tool, not part of the shipped CLI. Writes raw message source to
// harvest-out/ (gitignored) so real formats can be inspected and redacted into fixtures.
import { ImapFlow } from 'imapflow';
import { mkdir, writeFile } from 'node:fs/promises';

const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT), secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  logger: false,
});

await client.connect();
await client.mailboxOpen(process.env.IMAP_MAILBOX ?? 'INBOX');
await mkdir('harvest-out', { recursive: true });

let n = 0;
for await (const msg of client.fetch({ from: 'trustbank.sg' }, { envelope: true, source: true })) {
  await writeFile(`harvest-out/${String(n).padStart(3, '0')}.html`, msg.source);
  console.log(n, msg.envelope.subject);
  n += 1;
  if (n >= 40) break;
}
await client.logout();
