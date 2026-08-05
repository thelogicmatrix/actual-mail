# Contributing

The most useful contribution is a parser for a bank that is not supported yet.
[docs/WRITING-A-PARSER.md](docs/WRITING-A-PARSER.md) is the guide. This page is the shorter
question of what makes a change mergeable.

## Before you open a pull request

```bash
npm test        # the unit suite, all offline
npm run scan    # the leak gate, must report nothing in the files you touched
```

Both run without credentials, without a mailbox and without a network. If a change of yours
needs any of those to be tested, say so in the pull request rather than leaving the test out
silently.

CI runs those two on Node 20 and 22, plus two things you may not be able to run locally:
`bash scripts/test-run-sh.sh` (needs `flock`, so Linux or WSL only) and a `docker build` of the
image. A red PR on either is not something you did wrong in the code you can test.

## A parser without a fixture will not be merged

Every parser ships with two things:

1. **A redacted sample of that bank's real mail**, in `test/fixtures/<parser-id>/` — the
   directory is named after the parser's `id`, and `test/fixture-coverage.test.js` fails CI
   if a registered parser has none.
2. **A test asserting the row that sample produces**, field by field.

This is the one rule with no exceptions, and the reason is not process for its own sake. The
maintainer does not receive your bank's mail. There is no other way to check that your regular
expression captures the merchant rather than the boilerplate beside it, that your amount is
signed the right way, or that your date survived the month table. Your fixture is the only
evidence, and it is also what will catch the redesign your bank ships in two years, on someone
else's machine, long after you have stopped thinking about this.

The coverage promise this repository makes to its users is per parser, not global: a bank is
listed because a redacted sample of its mail is in the tree with a passing test, and for no
other reason. A parser with no fixture would make that promise false for everyone.

Redaction is a section of its own in the parser guide, because it is the step where you could
publish your own account number. Read it before you commit a fixture.

## Run the scanner from the repository root

`scripts/scan-pii.js` and `scripts/redact.js` both resolve `private.local.json` against the
current working directory. Run either from a subdirectory and it finds no rule file, applies
zero of your personal literal rules, and reports nothing wrong. Same command, same green-looking
output, none of the protection.

So always:

```bash
cd /path/to/actual-mail && npm run scan
```

The gate exits non-zero on any finding and the tree is clean today, so expect exit 0. A red gate
means something you added — fix it rather than filtering the output. It is the only thing standing
between a contributed fixture and someone's real bank data, so it is not a formality.

## House style

- **Explain why, not what.** The comments in this codebase are mostly about a failure that
  actually happened, and they carry the date. If your change encodes a lesson, write the lesson
  down next to it. If you are only restating the code in English, delete the comment.
- **Money is never a float.** Amounts travel as decimal strings and are converted with integer
  arithmetic. The two places a float is unavoidable are the exchange rate itself and the number
  the Wise API hands over, and both are commented as such.
- **Fail loudly.** An unmapped account, an unrecognised email, an unreachable source: all of
  them are errors with a non-zero exit code, never a skip. A silent skip in this tool means a
  transaction quietly missing from someone's budget, which is the failure mode the whole project
  exists to prevent. If you add a code path that can drop a row, it has to count what it dropped
  and say so.
- **No new dependencies for what a few lines can do.** There are four runtime dependencies. Each
  one is doing work that would be genuinely hard to write.

## What is out of scope

Categorisation, budgeting logic, and anything that guesses. This tool extracts what the bank
said and writes exactly that. A row it cannot produce honestly is a row it reports as a failure.

## Reporting a bug

Include the exit code, the stderr output, and the redacted body text of the message involved if
there is one. Redact it first, using the vocabulary in the parser guide. Never paste a real
merchant, account number or email address into an issue.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE)
that covers this project.
