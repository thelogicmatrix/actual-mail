import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { retry } from './retry.js';

export async function toMessage({ envelope, source }) {
  const messageId = envelope?.messageId;
  if (!messageId) throw new Error('message has no Message-ID; cannot build a stable row id');

  // simpleParser decodes quoted-printable, multipart and charset. Passing raw RFC822 source
  // to html-to-text does not: Trust's mail wraps at 76 chars with "=\r\n" soft breaks that
  // land mid-word, and any regex over that text fails unpredictably.
  const parsed = await simpleParser(source);
  const text = parsed.text ?? convert(parsed.html ?? '', { wordwrap: false });

  return {
    messageId,
    subject: envelope.subject ?? '(no subject)',
    // Collapse whitespace: decoded bodies still wrap, and every parser pattern spans words.
    text: text.replace(/\s+/g, ' ').trim(),
  };
}

export async function* fetchMessages({ host, port, user, pass, mailbox = 'INBOX', from, since }) {
  // Only the connect is retried, and a fresh client is built per attempt: an ImapFlow instance
  // that failed to connect is spent, and reconnecting on the same object is not a supported
  // path. Retrying mid-iteration is not an option either — it would re-yield messages the
  // caller has already consumed. A DNS blip on connect used to fail the whole trust source
  // (2026-08-01 11:15 and 2026-08-02 17:15, both "getaddrinfo EAI_AGAIN imap.gmail.com").
  const client = await retry(async () => {
    const c = new ImapFlow({
      host, port: Number(port), secure: true, auth: { user, pass }, logger: false,
    });
    await c.connect();
    return c;
  });
  try {
    await client.mailboxOpen(mailbox);
    const query = since ? { from, since } : { from };
    for await (const msg of client.fetch(query, { envelope: true, source: true })) {
      yield await toMessage(msg);
    }
  } finally {
    // An exception mid-iteration must still close the session, or Gmail refuses the next
    // connection with too many open sessions.
    await client.logout();
  }
}
