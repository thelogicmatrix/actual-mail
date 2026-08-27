# Writing a parser for your bank

A parser turns one bank's alert email into one transaction row. It is a regular expression, a
date conversion and a call to `makeRow`, and it is about forty lines including the ignore list.

This guide is in dependency order. Nothing below uses a concept that has not been introduced,
so read it top to bottom the first time.

**One thing to know before you start.** A parser is only merged if a redacted sample of your
bank's real mail comes with it, in `test/fixtures/`, with a test asserting the row it produces.
That is not bureaucracy. The maintainer does not receive your bank's mail, so your fixture is
the only thing that can verify your parser, and it is the only thing that will notice when your
bank redesigns its emails two years from now. Redacting that sample is a section of its own
below, because it is where you could leak your own data.

## 1. What a row is

Every parser returns the same shape. `makeRow` in [`src/row.js`](../src/row.js) builds it, and
nothing else may.

| Field | Type | What it holds |
|---|---|---|
| `id` | string | `sha256(source + NUL + rawRef + NUL + account)`, where NUL is a literal `0x00` byte and **not** a space. `makeRow` computes it. Do not set it. |
| `source` | string | Which feed this came from. Stable forever, see the note in section 6. |
| `account` | string | Which of *your* accounts moved. Becomes a key in `mapping.json`. |
| `date` | string | Full timestamp with the bank's own offset, for example `2026-02-12T01:08:00+08:00`. Not a bare date. |
| `amount` | string | A decimal **string**, signed. Negative is money out. `makeRow` throws if you pass a number. |
| `currency` | string | Three letters, the currency the alert quoted. Never converted here. |
| `payee` | string | Merchant, or the other side of a transfer. |
| `type` | string | What kind of movement, for example `card`, `refund`, `transfer_in`, `transfer_out`, `pot_transfer`. |
| `raw_ref` | string | The email's `Message-ID`. Passed in as `rawRef`. |

Three of those carry rules worth stating outright.

**`amount` is a string, deliberately.** Money never becomes a float in this codebase.
`Math.round(Number('19.99') * 100)` is the obvious alternative and it is wrong often enough to
matter, so the decimal string travels intact until the loader converts it with integer
arithmetic.

**`amount` carries the sign, and refunds are positive.** A cancellation or a refund offsets an
earlier authorisation. Neither kind of email references the original, so an offsetting positive
row is the only correct shape. Importing them negative would double-count the spend.

**`date` keeps the bank's offset.** Do not normalise it to a bare `YYYY-MM-DD`, and do not
convert it to UTC. The loader derives the calendar day itself, from the offset you preserve. It
has to: taking the day off the front of a UTC string booked every early-morning Singapore
movement to the previous day, and at a month boundary into a period that had already been
closed.

A real row, printed by the parser written in section 3:

```json
{
  "id": "b81889967e9925b3bc8d8e61ff03f389fc9fb76002d88c51248fa6924b7f3724",
  "source": "example",
  "account": "card",
  "date": "2026-02-12T01:08:00+08:00",
  "amount": "-12.34",
  "currency": "SGD",
  "payee": "TEST MERCHANT SG",
  "type": "card",
  "raw_ref": "<abc123@example.com>"
}
```

## 2. What `parse()` receives

```js
parse(text, rawRef, subject)
```

- **`text`** is the email body, **already decoded and already flattened**. The mailbox layer
  runs the message through a mail parser, so quoted-printable, multipart and charset are gone.
  If the mail is html-only it has been converted to text. Then all runs of whitespace are
  collapsed to single spaces and the ends trimmed. You are matching a single long line of plain
  text. You never see html, tags, `=\r\n` soft line breaks, or `&amp;`.
- **`rawRef`** is the `Message-ID`. Pass it straight to `makeRow` as `rawRef`. It is what makes
  the row id stable across runs, which is what makes the import idempotent.
- **`subject`** is the email subject, or `(no subject)`. Only useful for the ignore list in
  section 4.

Here is real `text`, from a redacted fixture in this repo, wrapped here for reading but arriving
as one line. The timestamp will not match the copy in your checkout: fixture dates are shifted
by a per-run offset when they are regenerated, so that the published set does not record when a
real person transacted. The *rendering* is what matters here and that is untouched.

```
Didn't do this? Please contact us via your Trust App. You've spent SGD 12.34 at
TEST MERCHANT SG on 12 Feb 2026 01:08SGT with Trust Link card. Not you? Alert us
via Trust App. [https://example.com/ Trust Bank Singapore Ltd | ...
```

Two things that catches people. The boilerplate is part of `text`, so anchor your pattern on
the sentence you want rather than on the start of the body. And the useful sentence is
surrounded by other sentences containing money-shaped and date-shaped text, so a lazy `(.+?)`
with nothing solid after it will happily run past your merchant name.

## 3. A complete parser

Say your bank sends this, one alert per card payment. Call the bank Example Bank.

```
Example Bank: a card payment of SGD 12.34 to TEST MERCHANT SG on 12 Feb 2026 at
01:08 was approved. Not you? Call us.
```

`src/parsers/example-bank.js`, in full:

```js
import { makeRow } from '../row.js';

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

const SPEND = /card payment of ([A-Z]{3}) ([\d,]+\.\d{2}) to (.+?) on (\d{1,2}) (\w{3}) (\d{4}) at (\d{2}:\d{2})/;

export function parseExample(text, rawRef, subject = '') {
  const m = SPEND.exec(text);
  if (m) return makeRow({
    source: 'example', account: 'card',
    date: `${m[6]}-${MONTHS[m[5]]}-${m[4].padStart(2, '0')}T${m[7]}:00+08:00`,
    amount: '-' + m[2].replaceAll(',', ''), currency: m[1], payee: m[3].trim(),
    type: 'card', rawRef,
  });
  if (/monthly statement/i.test(subject)) return { ignored: true, reason: 'subject' };
  return null;
}

// The registry contract. `from` is the IMAP FROM filter for this bank's alert mail — a bare
// domain or local part, never a full address, because the leak gate in section 5 rejects one.
export default { id: 'example-bank', from: 'example-bank.sg', parse: parseExample };
```

That is the whole thing, and it produces exactly the row printed in section 1.

Details in it that are not accidental. `[\d,]+\.\d{2}` allows a thousands separator, which is
stripped before the string reaches `makeRow`. The merchant capture `(.+?)` is immediately
followed by a full date, so it cannot swallow an " on " that appears inside a merchant name.
The `+08:00` offset is hardcoded, because it is a fact about how this bank writes its emails,
not a global setting. Put your bank's own offset in your own parser.

The default export is the whole contract: an `id`, a `from` fragment used as the mailbox search
filter, and `parse`. A test in `test/parsers.test.js` asserts that shape for every registered
parser, so getting it wrong fails the suite rather than failing at 05:30.

Keep `from` a fragment. The IMAP FROM search matches on substring, so a bare domain or local part
loses no selectivity, and `scripts/scan-pii.js` flags a full `user@host` that is not an
`example.com` placeholder — put your bank's real sender address here and the gate in section 5
fails on the one line this example handed you.

## 4. The three return values

`parse()` may return exactly one of three things.

**A row.** You recognised the message and it is a transaction.

**`{ ignored: true, reason: '...' }`.** You recognise this as mail your bank sends that is not a
transaction: a statement notice, a new-payee confirmation, marketing. It is counted and
discarded. Check the ignore list only *after* every transaction pattern has failed, as the
example does, so a loose ignore pattern can never swallow a real transaction.

**`null`.** You do not recognise this message at all.

`null` is loud on purpose. The caller reports it as `UNPARSED <message-id> <subject>` on stderr
and **sets a non-zero exit code**, which makes the scheduled runner alert. Rows that did parse
are still written first, so one unknown email never discards a good batch.

That is the whole point of the design. Your bank will redesign its emails eventually, and the
only two possible behaviours are "tell you" and "silently lose transactions". `null` is how a
parser says "tell them".

So be honest with `null` and stingy with `ignored`. An `ignored` pattern that is too broad is
the one way this tool can lose money quietly. If your bank sends enough marketing to be
annoying, match its subjects specifically rather than reaching for a catch-all. The bundled
Trust parser has one general fallback and it is deliberately narrow: a body containing no
money-shaped token at all cannot be a transaction format that was missed.

## 5. Redacting your sample, before you commit anything

This is the step where you could leak your own data into a public repository. Do it before you
commit, and **stage before you scan** — step 4 says why.

1. Copy `private.example.json` to `private.local.json` and fill in your own name, email address
   and any account or pot nicknames. That file is gitignored and never leaves your machine.
   `scripts/scan-pii.js` reads it, so the gate in step 4 knows your own strings and not just
   PII-shaped ones. (`scripts/redact.js` reads it too, but that script is wired to the bundled
   Trust parser's sentence shapes and its output directory — for a new bank you redact by hand,
   as step 3 says. It now refuses to write a fixture whose payee it did not replace, rather than
   reporting success over an unredacted file.)
2. Save the alert email's **body text** to `test/fixtures/<parser-id>/<case>.txt`, the directory
   named exactly after your parser's `id` — `test/fixture-coverage.test.js` checks it. Body text,
   not the raw `.eml`. Redaction has to be verifiable by grep, and a merchant split across a
   quoted-printable line break cannot be grepped for.
3. Replace by hand, using this vocabulary, because the leak gate knows these placeholders and
   will flag anything else of the same shape:
   - the merchant becomes `TEST MERCHANT SG`, with the country code swapped for the one your
     case needs
   - account digits become `ending 0000`
   - amounts become obviously fake round numbers
   - any pot or account nickname becomes `TEST POT`
   - your own name and email become `testuser` and `testuser@example.com`
4. Stage your new files, **then** run the gate:

   ```bash
   git add src/parsers/<parser-id>.js test/fixtures/<parser-id>
   npm run scan
   ```

   Staging first is not tidiness: `scan-pii.js` enumerates `git ls-files`, so run it over
   untracked files and it scans none of them and prints clean — a green gate over the exact
   work you wanted checked, which is worse than no gate because you would trust it.

   It names the file and the offending string for anything that survived, and it exits
   non-zero for as long as it has findings. Do not commit until your files are clean.

The scanner is not a substitute for reading your own fixture. It catches shapes: email
addresses, four-digit account endings, uppercase merchant-and-country strings, identity
numbers, phone numbers, private network addresses. It does not catch a merchant name that
happens to look like ordinary words, and it cannot know that a date is your birthday. Read the
file.

One trap worth naming, because it fails quietly: run `npm run scan` and `scripts/redact.js`
from the repository root. `scripts/redact.js` resolves `private.local.json` against the current
directory, so
run either from a subdirectory and it finds no rule file, applies zero of your literal rules,
and reports nothing wrong.

## 6. Registering the parser

Two lines in [`src/parsers/index.js`](../src/parsers/index.js):

```js
import exampleBank from './example-bank.js';

export default [trustSg, exampleBank];
```

It is an explicit list rather than a directory scan, on purpose. It is greppable, it shows up in
a pull-request diff, and a stray file dropped into that folder cannot start reading someone's
mailbox by accident.

Your `id` becomes a `--source` value, so `--source example-bank` runs only your parser and
`--source all` runs everything. Three words are already taken and a test will fail if you claim
one: `all`, `wise`, and `trust`, which is a pre-1.0 alias rewritten to `trust-sg` before the
parser loop ever sees it.

**`id` and `source` are allowed to differ, and in one case they do.** The bundled parser's `id`
is `trust-sg` while the rows it emits carry `source: 'trust'`. That is deliberate and must not
be tidied up. The row id is `sha256(source + NUL + rawRef + NUL + account)` — a literal `0x00`
byte between the parts, so that `('tru', 'stx')` and `('trust', 'x')` cannot collide — and it is
what Actual stores as the import id of every already-imported transaction, so changing `source`
changes every future row id and breaks duplicate detection against everything already in the
budget. The rule for you:
pick your `source` value once, when you write the parser, and never change it. The `id` is a
command-line label and can be renamed freely.

## 7. The test

`test/example-bank.test.js`. The fixture holds the decoded body text, which is exactly what
`parse` receives, so the test needs no mailbox and no network.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExample } from '../src/parsers/example-bank.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/example-bank/${name}.txt`, import.meta.url), 'utf8').trim();

test('a card payment is negative, in the currency the alert quoted', () => {
  const row = parseExample(fixture('card'), '<abc123@example.com>', 'Card payment approved');
  assert.equal(row.type, 'card');
  assert.equal(row.account, 'card');
  assert.equal(row.amount, '-12.34');
  assert.equal(row.currency, 'SGD');
  assert.equal(row.payee, 'TEST MERCHANT SG');
  assert.equal(row.date, '2026-02-12T01:08:00+08:00');
});

test('a statement notice is ignored, not reported as unparsed', () => {
  const result = parseExample(fixture('statement'), '<def456@example.com>', 'Your monthly statement is ready');
  assert.deepEqual(result, { ignored: true, reason: 'subject' });
});

test('an unrecognised message returns null so the run fails loudly', () => {
  assert.equal(parseExample('Something we have never seen, with SGD 5.00 in it', '<x>', 'Surprise'), null);
});
```

Assert the whole row, field by field, rather than just that something came back. The failure
you want this test to catch, years from now, is a redesign that still matches your pattern but
captures a different substring. Assert the date string exactly, not with a loose pattern: an
off-by-one in a month table or a dropped offset is exactly the kind of bug a `/^\d{4}-/` check
waves through.

Those three tests are the minimum: one transaction, one ignored, one `null`. Add one per
message shape your bank actually sends. Each one needs its own fixture.

Run them:

```bash
npm test
```

## 8. Pull-request checklist

- [ ] `src/parsers/<your-bank>.js` exports `{ id, from, parse }` as its default.
- [ ] Registered in `src/parsers/index.js`.
- [ ] At least one redacted fixture per message shape, under `test/fixtures/<parser-id>/`.
- [ ] A test asserting the full row for each shape, plus one `ignored` case and one `null` case.
- [ ] `npm test` passes.
- [ ] `npm run scan` reports nothing in the files you added — run from the repository root, and
      **after** staging them, or it never looks at them.
- [ ] You read your own fixtures with your own eyes after redacting them.
- [ ] `amount` is a string, `date` keeps the bank's offset, refunds are positive.

## The real thing

[`src/parsers/trust-sg.js`](../src/parsers/trust-sg.js) is what a mature parser looks like. It
handles four message families across a dozen patterns: card spends in three different word
orders, cancellations and refunds as positive offsets, transfers in both directions, and pot
moves that read differently depending on which way the money went. It composes its patterns
from shared fragments for the amount, the timestamp and the apostrophe, because the bank uses a
typographic apostrophe in some emails and a plain one in others.

Read it once you have your own parser working, not before. It is the shape a parser grows into
after a few hundred real emails, and it is a poor starting point.
