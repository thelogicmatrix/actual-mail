// Developer tool. Counts distinct Trust subjects across the whole mailbox so the
// parser's type list is derived from real mail rather than a sample.
import { ImapFlow } from 'imapflow';

const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT), secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  logger: false,
});

await client.connect();
await client.mailboxOpen(process.env.IMAP_MAILBOX ?? 'INBOX');

const counts = new Map();
let total = 0;
for await (const msg of client.fetch({ from: 'trustbank.sg' }, { envelope: true })) {
  const subject = (msg.envelope.subject ?? '(none)').trim();
  counts.set(subject, (counts.get(subject) ?? 0) + 1);
  total += 1;
}
await client.logout();

console.log(`total ${total} messages, ${counts.size} distinct subjects\n`);
for (const [subject, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(4), subject);
}
