import { parseArgs } from 'node:util';
import { fetchMessages } from './imap.js';
import parsers from './parsers/index.js';
import { fetchWise } from './sources/wise.js';
import { toCsv, toJsonl } from './output.js';

export async function collect(messages, parse) {
  const rows = [];
  const unparsed = [];
  let ignored = 0;
  for await (const msg of messages) {
    // Per MESSAGE, not per source. A parser that THROWS — an unexpected month name, a message
    // with no Message-ID — used to propagate out of this loop, so `collect` never returned and
    // every row it had already extracted was discarded. Worse than the loss: it surfaced as
    // `SOURCE FAILED <id>`, which run.sh classifies as the self-healing kind and holds for three
    // runs, while a message stuck in the mailbox never heals. README promises "no fourth outcome
    // and no silent skip" for a fetched message; a throw was the fourth outcome.
    //
    // A throw is treated as unparsed, not as a source failure: the message is named, the rest of
    // the batch survives, and the run still exits non-zero through the unparsed path — which is
    // deliberately NOT streak-gated, because a parser that throws does not fix itself.
    let result;
    try {
      result = parse(msg.text, msg.messageId, msg.subject);
    } catch (e) {
      // `note` is OUR text, never the bank's. See the write-out below for why that matters.
      unparsed.push({ messageId: msg.messageId, note: `parser threw: ${e.message}` });
      continue;
    }
    if (result === null) unparsed.push({ messageId: msg.messageId });
    else if (result.ignored) ignored += 1;
    else rows.push(result);
  }
  return { rows, unparsed, ignored };
}

const USAGE = `actual-mail — bank alert emails and Wise -> normalised transaction rows

Usage: actual-mail [options]

  --since <date>     only fetch from this date (ISO, e.g. 2026-07-01)
  --format csv|jsonl output format (default csv)
  --source all|<parser-id>|wise   (ids: ${parsers.map((p) => p.id).join(', ')}, wise)
  --help

Rows go to stdout. Unrecognised messages are reported on stderr and set a
non-zero exit code — parsed rows are still emitted.
`;

export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      since: { type: 'string' },
      format: { type: 'string', default: 'csv' },
      source: { type: 'string', default: 'all' },
      help: { type: 'boolean', default: false },
    } }));
  } catch (e) {
    // A typo'd flag threw a node-internals stack trace at a first-time user. Print the usage the
    // tool already has instead, and exit 2 so it is distinguishable from a run that worked.
    process.stderr.write(`${e.message}

${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // `--source trust` was the pre-1.0 spelling. Silently extracting zero rows because a
  // flag no longer matches is exactly the quiet failure this project exists to prevent.
  if (values.source === 'trust') values.source = 'trust-sg';

  if (values.help) { process.stdout.write(USAGE); return; }

  // The line above handled the ONE rename anybody had thought of, and left the general case open:
  // `--source dbs` matched no parser, skipped the Wise branch, wrote a bare CSV header and exited
  // 0. run.sh then saw no rows, cleared its alert state and beat the heartbeat UP — a total feed
  // outage reported as healthy, off a one-character mistake. Parser ids are a contributor-supplied
  // namespace now, so a typo is likelier than it was when there were two fixed literals.
  const sources = ['all', 'wise', ...parsers.map((p) => p.id)];
  if (!sources.includes(values.source)) {
    process.stderr.write(`unknown --source "${values.source}" — expected one of: ${sources.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }
  if (!['csv', 'jsonl'].includes(values.format)) {
    process.stderr.write(`unknown --format "${values.format}" — expected csv or jsonl\n`);
    process.exitCode = 1;
    return;
  }
  // An unparseable --since reaches the IMAP search as an Invalid Date and the Wise leg as
  // `Invalid time value`, reported as a source failure. run.sh builds this from `date -d`, so a
  // host without GNU date passes an empty string here.
  if (values.since !== undefined && Number.isNaN(new Date(values.since).getTime())) {
    process.stderr.write(`--since "${values.since}" is not a date (expected e.g. 2026-07-01)\n`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  const unparsed = [];
  const failed = [];
  let ignored = 0;

  // Each parser is caught independently. `--source all` used to run everything as one
  // throw-or-nothing: on 2026-07-29 a DNS blip on Wise ended the process before stdout was
  // written, taking the Trust rows already in `rows` with it. One dead source must never
  // discard what another parsed correctly.
  //
  // A failed source is still a non-zero exit, so run.sh alerts. It just alerts about a
  // partial batch instead of losing a whole one.
  for (const parser of parsers) {
    if (values.source !== 'all' && values.source !== parser.id) continue;
    try {
      const messages = fetchMessages({
        host: process.env.IMAP_HOST, port: process.env.IMAP_PORT,
        user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD,
        mailbox: process.env.IMAP_MAILBOX, from: parser.from,
        since: values.since ? new Date(values.since) : undefined,
      });
      const r = await collect(messages, parser.parse);
      rows.push(...r.rows);
      unparsed.push(...r.unparsed);
      ignored += r.ignored;
    } catch (e) {
      // `e.message` alone was empty for the commonest first-run failure — bad or absent IMAP
      // credentials — so the run printed `SOURCE FAILED trust-sg:` with nothing after the colon,
      // and run.sh recorded a reason= field with no reason. The documented contract is
      // `SOURCE FAILED <id>: <reason>`; this keeps it true whatever the client throws.
      failed.push(`${parser.id}: ${e.message || e.code || e.constructor?.name || 'unknown error'}`);
    }
  }

  // "Not configured" and "configured but broken" are different states, and conflating them made
  // the documented Quickstart fail for every user without a Wise account: Wise is in the default
  // `--source all`, an unset token threw, and run.sh hardcodes `--source all` — so a Wise-less
  // deployment failed on every run forever. An EXPLICIT `--source wise` still fails loudly on a
  // missing token, because there the user has said they want it.
  if (values.source === 'wise' || (values.source === 'all' && process.env.WISE_API_TOKEN)) {
    try {
      rows.push(...await fetchWise({
        token: process.env.WISE_API_TOKEN,
        since: values.since ?? new Date(Date.now() - 30 * 864e5).toISOString(),
        until: new Date().toISOString(),
      }));
    } catch (e) {
      failed.push(`wise: ${e.message}`);
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));

  // Rows are written BEFORE the exit code is set: one unrecognised email must never
  // discard the batch that parsed correctly.
  process.stdout.write(values.format === 'jsonl' ? toJsonl(rows) : toCsv(rows));

  process.stderr.write(`${rows.length} row(s), ${ignored} ignored\n`);
  // The Message-ID, never the subject. This stderr becomes the body of a webhook alert, and a
  // bank's alert subject carries the amount and often the merchant -- so the one place data left
  // the host was posting transaction detail to a third party that retains it indefinitely, on the
  // failure that happens in NORMAL operation. The Message-ID identifies the mail in your own
  // mailbox, which is where the subject already is.
  for (const u of unparsed) {
    process.stderr.write(`UNPARSED ${u.messageId}${u.note ? ` [${u.note}]` : ''}\n`);
  }
  if (unparsed.length > 0) {
    process.stderr.write(
      `${unparsed.length} message(s) matched no parser — a new format, or a redesign\n`);
    process.exitCode = 1;
  }
  // Last, and on its own line per source, because run.sh fingerprints this text to decide
  // whether an hourly run has anything new to say. A stable line is what makes a standing
  // fault cost one message a day instead of one an hour.
  for (const f of failed) process.stderr.write(`SOURCE FAILED ${f}\n`);
  if (failed.length > 0) process.exitCode = 1;
}
