import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMessage } from '../src/imap.js';

// A soft line break (=\r\n) splitting "received" mid-word, exactly as Trust sends it.
// This is the bug this module exists to prevent: undecoded quoted-printable leaves words
// broken at arbitrary points and every parser pattern fails depending on where the
// 76-character wrap landed.
const QP_SOURCE = Buffer.from(
  'Content-Type: text/html; charset=utf-8\r\n'
  + 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
  + '<html><body><p>Sweet! You have rec=\r\neived SGD 1.00 from TEST BANK</p></body></html>\r\n');

test('quoted-printable soft line breaks are decoded, not left mid-word', async () => {
  const msg = await toMessage({ envelope: { messageId: '<a@b>', subject: 's' }, source: QP_SOURCE });
  assert.match(msg.text, /received SGD 1\.00/);
  assert.doesNotMatch(msg.text, /rec=\s*eived/);
});

test('toMessage maps the envelope', async () => {
  const msg = await toMessage({
    envelope: { messageId: '<a@b>', subject: 'Yay! Transaction successful' }, source: QP_SOURCE });
  assert.equal(msg.messageId, '<a@b>');
  assert.equal(msg.subject, 'Yay! Transaction successful');
});

test('toMessage tolerates a missing subject', async () => {
  const msg = await toMessage({ envelope: { messageId: '<c@d>' }, source: QP_SOURCE });
  assert.equal(msg.subject, '(no subject)');
});

test('toMessage rejects when the Message-ID is absent', async () => {
  await assert.rejects(() => toMessage({ envelope: {}, source: QP_SOURCE }), /Message-ID/);
});

test('whitespace is collapsed so patterns can span original line breaks', async () => {
  const src = Buffer.from(
    'Content-Type: text/html; charset=utf-8\r\n\r\n'
    + '<html><body><p>You have received\r\n\r\n   SGD 2.00   from\tTEST BANK</p></body></html>\r\n');
  const msg = await toMessage({ envelope: { messageId: '<e@f>', subject: 's' }, source: src });
  assert.match(msg.text, /You have received SGD 2\.00 from TEST BANK/);
});

test('an HTML-only message with no text part still yields text', async () => {
  const src = Buffer.from(
    'Content-Type: text/html; charset=utf-8\r\n\r\n'
    + '<html><body><table><tr><td>You have received SGD 3.00 from TEST BANK</td></tr></table></body></html>\r\n');
  const msg = await toMessage({ envelope: { messageId: '<g@h>', subject: 's' }, source: src });
  assert.match(msg.text, /You have received SGD 3\.00 from TEST BANK/);
});
