// Developer tool. Turns harvest-out/by-type/*.html into redacted .txt fixtures.
//
// Fixtures hold the DECODED, whitespace-collapsed body text — exactly the string
// parseTrust() receives. The surrounding marketing HTML contributes nothing to parsing
// (mailparser flattens it), and a short text fixture is reviewable at a glance, which is
// what redaction verification for a public repo actually needs.
//
// Quoted-printable decoding is covered separately by a purpose-built buffer in
// test/imap.test.js.
import { simpleParser } from 'mailparser';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Directory is named after the parser id, which fixture-coverage.test.js enforces.
const OUT = 'test/fixtures/trust-sg';

// Distinct per fixture so a test can identify a fixture by its value alone.
const AMOUNTS = {
  card: '12.34', 'card-overseas-sgd': '23.45', 'card-overseas-gmt': '99.99', 'fx-card': '34.56',
  'paynow-out': '45.67', 'paynow-in': '56.78', 'kaching-in': '67.89',
  'local-out': '78.90', 'pot-transfer': '89.01',
  cancel: '90.12', 'fx-cancel': '11.22', refund: '22.33', 'fx-refund': '13.44',
};

// The same shapes the parser uses, so whatever it would extract is what gets replaced.
const PAYEE_SPANS = [
  /spent (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} using Trust Link card at (.+?) on \d{1,2} \w{3} \d{4}/,
  /spent (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} at (.+?) with Trust Link card on \d{1,2} \w{3} \d{4}/,
  /spent (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} at (.+?) on \d{1,2} \w{3} \d{4}/,
  /cancelled your purchase of (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} at (.+?) on \d{1,2} \w{3} \d{4}/,
  /refunded (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} from (.+?) to your Trust card on \d{1,2} \w{3} \d{4}/,
  /[Tt]ransfer of (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} from A\/C ending \d{4} to (.+?) on \d{1,2} \w{3} \d{4}/,
  /received a PayNow transfer of (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} from (.+?) on \d{1,2} \w{3} \d{4}/,
  /have received (?:S\$|[A-Z]{3})\s*[\d,]+\.\d{2} from (.+?) on \d{1,2} \w{3} \d{4}/,
];

// The literals are one person's real name, email and pot names — they are the thing being
// redacted, so they cannot live in a public repo. private.local.json is gitignored;
// private.example.json is the committed template. Missing file means structural redaction
// only, which is the right default for a contributor redacting their own mail.
//
// Deliberately NOT imported from scan-pii.js's near-identical literalRules(): that one drops
// `replacement` (the gate only needs to match), and coupling a developer tool to the release
// gate serves neither.
// `g` is forced on, not defaulted. `flags: "i"` is the dangerous case a bare `|| 'g'` misses:
// it is a present-but-non-global value, so the fallback never fires and only the FIRST
// occurrence of the contributor's name is redacted. scan-pii.js:75 hardens the same input the
// same way — a literal rule is "always flag/replace this", never "the first one".
// Throws on a file that exists but declares nothing, for the same reason scan-pii.js does: a
// one-character typo in the key defaulted `literals` to [] and this tool then redacted the
// structure, announced every fixture as written, and left the contributor's name in all of them.
export function loadLiterals(path = 'private.local.json') {
  if (!existsSync(path)) return [];
  const { literals } = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(literals)) {
    throw new Error(`${path} exists but has no "literals" array — check the key spelling. `
      + 'Refusing to redact with 0 literal rules, which looks exactly like a successful run.');
  }
  return literals.map((l) => {
    const flags = l.flags?.includes('g') ? l.flags : (l.flags || '') + 'g';
    return [new RegExp(l.pattern, flags), l.replacement];
  });
}

export function applyLiterals(text, rules) {
  // `$` escaped, because String.replace reads the replacement as a substitution pattern: a
  // replacement containing `$&` puts the matched PII straight back into the "redacted" text.
  for (const [re, to] of rules) text = text.replace(re, String(to).replaceAll('$', '$$$$'));
  return text;
}

// Placeholders must satisfy scan-pii.js's ALLOWED list, or every fixture this tool produces
// trips the release gate. Hence `ending 0000`: the gate allows only an all-zero digit run,
// and any other run reads like a real account number. Don't write a counter-example digit
// run in a comment here either — the gate scans this file, and that cost one round trip.
function replacementFor(payee, slug) {
  if (slug.includes('pot')) return 'TEST POT';
  if (/A\/C ending/.test(payee)) return 'TEST BANK A/C ending 0000';
  // Any two-letter code, matching the gate's merchant rule. The enumerated list was the nine
  // countries one person's own statements happened to contain, so a Malaysian or Japanese
  // merchant lost its country suffix in the placeholder — and the fixture then stopped
  // exercising the shape the gate is looking for.
  const country = /\b([A-Z]{2})\s*$/.exec(payee)?.[1];
  return country ? `TEST MERCHANT ${country}` : 'TEST COUNTERPARTY';
}

// Every timestamp moved by ONE offset, drawn once per run and never written down.
//
// Amounts, merchants and counterparties were already fake, so the money was never exposed — but
// the dates were passed through untouched, on the reasoning that clobbering them would leave
// fixtures dated "12 Feb 0000" and break every date assertion. That reasoning is right about the
// format and wrong about the value: what shipped was a public record of when a named individual
// (the LICENSE names him) transacted, two of them past midnight. A pattern of life is
// identifying even when the amounts are not.
//
// A hardcoded offset would have been theatre — it ships in this file, so anyone could subtract
// it straight back out. Drawn per run, uniform across every fixture, so the rendering (padded or
// bare day, spacing before the timezone, the GMT+08:00 variant) survives byte for byte and only
// the values move. Fixtures are therefore NOT reproducible between runs; assert their shape, not
// their literal date.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Spelled out as a product rather than as one constant: milliseconds-per-day written as a
// literal is eight digits starting with an 8, which the gate reads as a Singapore phone number.
// It said so about this very line. Don't write the counter-example in this comment either.
const RUN_SHIFT_MS = -((180 + Math.floor(Math.random() * 900)) * 24 * 60 * 60 * 1000
  + Math.floor(Math.random() * 1440) * 60 * 1000);

export function shiftDates(text, shiftMs = RUN_SHIFT_MS) {
  return text.replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})(?:( +)(\d{2}):(\d{2}))?/g,
    (_m, d, mon, y, gap, hh, mm) => {
      // UTC arithmetic on purpose: the bank's own offset is rendered as a literal suffix in the
      // text and is not being moved, so a local-time Date would silently add the host's zone.
      const t = new Date(Date.UTC(+y, MONTHS.indexOf(mon), +d, +(hh ?? 0), +(mm ?? 0)) + shiftMs);
      const p2 = (n) => String(n).padStart(2, '0');
      // padStart to the ORIGINAL width: this bank writes "3 Feb" in one template and "05 Feb"
      // in another, and the parser is tested against both.
      const day = String(t.getUTCDate()).padStart(d.length, '0');
      const time = hh === undefined ? '' : `${gap}${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`;
      return `${day} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}${time}`;
    });
}

// Guarded: importing this file must not run the pipeline. test/redact.test.js imports
// applyLiterals, and an unguarded body would read the maintainer's real mail out of
// harvest-out/ and rewrite every fixture as a side effect of running the test suite.
// Same pathToFileURL form as scan-pii.js — a hand-built `file://` never matches on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const LITERAL_RULES = loadLiterals();

  await mkdir(OUT, { recursive: true });
  const files = (await readdir('harvest-out/by-type')).filter((f) => f.endsWith('.html'));
  let failed = 0;

  for (const file of files) {
    const slug = file.replace(/\.html$/, '');
    const parsed = await simpleParser(await readFile(`harvest-out/by-type/${file}`));

    let text = (parsed.text ?? '').replace(/\s+/g, ' ').trim();

    // Account digits first, so a fixture whose payee span never matches still has its digits
    // redacted. The replacement inserts its own already-redacted `ending 0000`.
    text = text.replace(/\bending\s*\d{4}\b/g, 'ending 0000');

    let payeeReplaced = false;
    for (const re of PAYEE_SPANS) {
      // The `d` flag gives exact capture-group indices. Neither replaceAll nor indexOf works
      // here: in a local transfer both accounts render identically after digit redaction, so
      // replaceAll clobbers both and indexOf finds the source instead of the destination —
      // either way the parser's "from A/C ending (\d{4}) to" can no longer match.
      const m = new RegExp(re.source, 'd').exec(text);
      if (!m?.indices?.[1]) continue;
      const [from, to] = m.indices[1];
      const payee = text.slice(from, to).trim();
      if (payee.length < 3) continue;
      text = text.slice(0, from) + replacementFor(payee, slug) + text.slice(to);
      payeeReplaced = true;
      break;
    }

    text = applyLiterals(text, LITERAL_RULES);
    text = text.replace(/\b\d[\d,]*\.\d{2}\b/g, AMOUNTS[slug] ?? '12.34');
    text = text.replace(/https?:\/\/[^\s"'<>]+/g, 'https://example.com/');
    // Phone numbers and order references. 5+ digits only — a 4-digit run is a year, and
    // clobbering those would leave fixtures dated "12 Feb 0000" and break date assertions.
    text = text.replace(/\b\d{5,}\b/g, '00000');
    // Last, so nothing above can re-mangle a date this just rewrote.
    text = shiftDates(text);

    // REFUSE rather than write a fixture whose payee was never replaced. PAYEE_SPANS are Trust's
    // sentence shapes; a different bank's wording matches none of them, every `continue` above
    // falls through, and the loop ends having changed nothing. The file was then written with the
    // real merchant or the real person's name still in it, announced as a success, and the
    // structural gate has no rule that catches a name or a merchant with no country code -- so
    // for exactly the contribution CONTRIBUTING asks for, this was a redactor that did nothing
    // and said it worked.
    //
    // Exit non-zero and name the file. A fixture is not something to half-produce.
    if (!payeeReplaced) {
      console.error(`${slug}.txt: no payee span matched, so NOTHING was redacted.`);
      console.error('  This tool only knows the bundled bank\'s sentence shapes. For a new bank,');
      console.error('  add your own spans to PAYEE_SPANS or redact by hand, then verify with');
      console.error('  `npm run scan` before committing.');
      failed += 1;
      continue;
    }
    await writeFile(`${OUT}/${slug}.txt`, text + '\n');
    console.log(`${slug}.txt  (${text.length} chars)`);
  }
  // Non-zero if any file was refused, so a pipeline or a habit of skimming output cannot turn
  // "nothing was redacted" into a green run.
  if (failed) {
    console.error(`\n${failed} file(s) written NOTHING and were skipped. See above.`);
    process.exit(1);
  }
}
