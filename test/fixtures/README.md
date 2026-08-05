# Fixtures

Real Trust Bank alert emails, decoded and redacted. Every identifying value is replaced:
amounts, merchants, counterparties, pot names and account digits are fake, and the dates and
times are shifted by a single offset drawn per run and not recorded anywhere. A timestamp of
when a named person transacted is identifying even when the amount beside it is invented, and
this file used to claim every identifying value was replaced in one sentence and that the dates
were untouched in the next.

What is genuinely untouched is the *rendering*: the timezone suffixes, the padded and unpadded
day forms, the currency spellings and the sentence structure. Those are what the parser is
tested against, and normalising them would defeat the fixture. Because the offset is redrawn on
every run, **assert the shape of a date, never its literal value.**

Each file holds the decoded, whitespace-collapsed body text: exactly the string
`parseTrust()` receives.

## Why `.txt` and not raw `.eml`

Redaction has to be grep-verifiable for a repo that ships publicly, and you cannot grep a
merchant name that quoted-printable has split as `Aud=\r\nible`. Verifiable redaction beats
fixture realism here.

Quoted-printable decoding is covered separately, and explicitly, by a purpose-built buffer
in `test/imap.test.js`.

## Coverage

Fixtures are one-per-**parse shape**, not one-per-subject. Three fixtures exist purely
because Trust renders card spends in three different word orders:

| Fixture | Shape |
|---|---|
| `card` | `at MERCHANT on DATE with Trust Link card` |
| `card-overseas-sgd` | `at MERCHANT with Trust Link card on DATE` |
| `fx-card` | `using Trust Link card at MERCHANT on DATE` |
| `card-overseas-gmt` | as above, but timezone renders `GMT+08:00` (1 message in 439) |

Amounts differ per fixture so a failing assertion identifies which fixture it came from.

## Regenerating

```sh
node --env-file=.env scripts/extract-formats.js    # one exemplar per subject-distinguishable type
node --env-file=.env scripts/extract-variants.js   # the two variants that share a subject
node scripts/redact.js                             # -> test/fixtures/trust-sg/*.txt
```

`redact.js` refuses to write a fixture whose payee span it could not find, so the two
`ignore-*` notices — which carry no payee at all — are never rewritten by it and are maintained
by hand. If you edit one, shift its date yourself.

`redact.js` reads its literal rules from `private.local.json`, which is gitignored (template:
`private.example.json`). Your own names, merchants and pot names go there and nowhere else. A
literal you forget to list is not redacted, so the gate below is the backstop rather than the
first line of defence:

```sh
node scripts/scan-pii.js
```

That is a structural scan plus your own literals. It cannot know a merchant you never told it
about, and it cannot know a name at all — it matches shapes, and the account-number spellings
it knows are the ones someone thought to list. Read the regenerated fixtures once yourself
before committing them. The gate is the backstop, not the first line of defence.

Never commit anything from `harvest-out/`, since it holds unredacted mail.
