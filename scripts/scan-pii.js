#!/usr/bin/env node
// The leak gate. Refuses to let personal data reach a public repo, and is the backstop that
// makes a contributed fixture safer to accept.
//
// Read that as written. It catches SHAPES: the account-number spellings enumerated below, an
// NRIC, a Singapore phone or address, a merchant with a country code, an email, a private host.
// It cannot catch a name, and it only knows the account-number wordings someone thought to
// list — a bank that words it some third way walks straight through. The header used to
// promise "the contributor's own account number is exactly what this catches", which the code
// cannot deliver for a bank it has never seen. test/fixtures/README.md says the honest version:
// read your regenerated fixture yourself, this is the backstop and not the first line.
//
// Two rule sets:
//   structural — PII-shaped regardless of whose it is. Always on, no config, so a fresh
//                clone with no private.local.json still gets the protection.
//   literal    — this maintainer's own strings, from the gitignored private.local.json.
//
// Exit 1 on any finding, so CI and the release checklist gate on the same command.
//
// Design rule, learned the hard way three times in this file: the gate FAILS CLOSED.
// Anything it cannot read, cannot resolve, or cannot decide is a finding, never a skip.
// A leak gate that passes by doing nothing is worse than no gate, because it manufactures
// confidence. Every `continue` below has to be justifiable as "definitely not PII".
//
// NOTE FOR ANYONE COMMITTING TO THIS REPO: --all-revs scans commit messages as well as
// blobs, and history is forever. Never quote a PII-shaped literal in a commit message —
// not as an example, not as a test fixture, not as proof that a rule works. Name the test
// that covers it instead. This rule has already been broken once, by this file's own author.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Placeholders the redaction pipeline is SUPPOSED to leave behind. A structural hit equal
// to one of these is the redactor working, not a leak.
//
// Every entry is anchored so it cannot match a substring of a larger hit; prefer both ends,
// and justify any single-ended entry inline. An unanchored prefix test here was a real hole:
// the merchant class contains a space, so one match spans several merchants, and the old
// `/^TEST /` waved the whole span through — a half-redacted line, precisely what this gate
// exists to catch.
//
// The noreply entries are not an exception to the gate, they are the gate agreeing with
// itself: a noreply address is the anonymised form of an identity, the opposite of a leak,
// and the history rewrite deliberately reauthors commits to @users.noreply.github.com.
// BOTH ends anchored, against a fixed list of domains. `^noreply@` alone pinned the local part
// on the reasoning that the local part is the payload — true for an identity and false for
// infrastructure, which this file's own comment below says is equally unpublishable:
// `noreply@<private-host>.<private-domain>` passed the gate and published a private hostname.
const ALLOWED = [
  /^TEST [A-Z]+(?: [A-Z]{2})?$/,
  // The account rule's placeholder form: no digit anywhere in the match except a trailing run
  // of zeros. Both ends anchored, and it cannot be satisfied by a real number — one non-zero
  // digit and `\D*` can no longer reach the end. Replaces `/^ending 0+$/i`, which was written
  // when the rule could only match the literal word "ending" and now misses `A/C ending 0000`.
  /^\D*0+$/,
  // The account-key rule's placeholder form. Single-ended on purpose and safe for it: the match
  // it is testing always ends in the colon that made it a key, so there is no longer string a
  // substring of this could satisfy.
  // The optional prefix run mirrors the rule above; the digits still have to be ALL zeros, so a
  // real account number cannot reach this however it is prefixed.
  /^[{,]?\s*['"]?(?:[a-z][a-z-]*:)*0+['"]?\s*:$/,
  /^[\w.+-]+@example\.(?:com|org|net)$/,
  /^noreply@(?:example\.(?:com|org|net)|anthropic\.com)$/i,
  /^[\w.+-]+@users\.noreply\.github\.com$/i,
  // Measured cost of widening the merchant rule's country code to /[A-Z]{2}/: these twelve are
  // every false positive it produces over this tree and its whole history. All of them are
  // screaming-caps English prose whose last word happens to be two letters (IS, OF, OR, TO, IN,
  // NO, BE, IP), and eight are the MIT licence. Both ends anchored, so none of them can swallow
  // a real merchant that shares its span — the failure the `/^TEST /` prefix test caused once.
  // A new all-caps sentence in the docs costs one line here. A missed merchant costs a leak
  // that is permanent, so this is the cheaper side of the trade to be on.
  /^(?:THE SOFTWARE IS|WITHOUT WARRANTY OF|EXPRESS OR|INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF|FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\. IN NO|AUTHORS OR COPYRIGHT HOLDERS BE|DAMAGES OR|WHETHER IN AN ACTION OF|OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN|A 403 IP|OR MIT OR|BY SWITCHING TO)$/,
];

// The gap a bank puts between the word and the digits: separators, masking (`**** `, `xxxx`),
// quotes, and the few connector words that carry no meaning of their own. Deliberately NOT
// "any 16 characters": that form also matched `card', date: '2026`, and a rule that flags a
// date literal in a test file is a rule people learn to override.
const ACCT_GAP = String.raw`(?:[\s:.,#*•x'"()\[\]/-]|\b(?:in|no|nos|number|ending|last|is|are|the|digits?)\b){0,8}`;

const STRUCTURAL = [
  ['email address', /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g],
  // `ending \d{4}` was Trust's exact wording and nothing else. Every other bank's spelling of
  // the same identifier walked through, verified one at a time: `card ending in 4829` (the word
  // "in" alone defeated it), `Card **** 4829`, `Acct xxxx4829`, `last 4 digits: 4829`,
  // `Account 0123456789 debited`. For a repo whose CONTRIBUTING asks strangers to send their own
  // bank mail, the one wording it knew was the one bank it already had a parser for.
  // 4 digits or more, because a full account number is not four digits and `\d{4}\b` cannot see
  // one. The all-zero placeholder is waved through by ALLOWED, as `ending 0000` always was.
  ['account number', new RegExp(String.raw`\b(?:a/c|acct|account|card|ending|digits?)\b${ACCT_GAP}\d{4,}\b`, 'gi')],
  // The same identifier without the word "ending" next to it. `mapping.json` keys an Actual
  // account by the last four digits the alert email carries (see trust-sg.js, `account: m[3]`),
  // so a bare four-digit run in a key position IS an account number by this project's own schema
  // -- and the rule above could not see it, because the giveaway word is absent. A real one sat
  // in scripts/verify-scratch.js and in five commits through a full history rewrite, with the
  // gate reporting clean the whole time.
  //
  // Anchored to a key position (`{`, `,` or line start) so a stack-trace line like
  // `net.js:1141:16` is not a finding. All-zero runs are the placeholder convention and are
  // waved through by ALLOWED, the same bargain `ending 0000` already makes.
  // The optional `<word>:` run inside the quotes is the mapping's own prefix convention --
  // `pot:`, `no-inbound-alert:`, `untracked:`. Without it every prefixed key was invisible to
  // this rule, so the one shape the schema says carries an account number was the one shape the
  // gate could not see. `[a-z-]+` only, so `net.js:1141:16` still needs its `.` and stays out.
  ['account key', /(?:[{,]|^)\s*['"]?(?:[a-z][a-z-]*:)*(\d{4})['"]?\s*:/gm],
  // Any two-letter code, not a list of nine. The list was the nine countries the maintainer's
  // own statements happened to contain, so `GRAB HOLDINGS MY` and the same line ending JP, AU,
  // TH, CN, IN, FR, KR, PH, VN, TW, CH or CA all scanned clean — Malaysia, Japan, Australia and
  // Thailand being the four places a Singapore cardholder most often transacts abroad, and a
  // contributor in Kuala Lumpur being exactly who this rule is here to protect.
  // Measured over this tree: 28 matches -> 40, i.e. 12 new false positives, every one all-caps
  // English prose and every one now in ALLOWED. Deliberately the noisy side of the trade.
  ['merchant + country', /\b[A-Z][A-Z0-9&'. -]{4,}\s+[A-Z]{2}\b/g],
  // Both appear in the bank alert emails this tool parses, so a contributed fixture is the
  // likely carrier. Case-insensitive: `nric s1234567d` in a lowercase log line used to pass,
  // which is the same identifier and the same leak.
  ['singapore NRIC/FIN', /\b[STFGM]\d{7}[A-Z]\b/gi],
  ['singapore phone', /\+65[ -]?\d{4}[ -]?\d{4}\b|\b[689]\d{7}\b/g],
  // An IBAN is an account number that carries its own country and check digits, so a European
  // contributor's alert mail leaks a whole account in one token and no rule above sees it.
  ['bank account (IBAN)', /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
  // A Singapore postcode is a building, and the unit number narrows it to a front door. Only
  // these two shapes, not a street-name rule: no card-PAN or free-text address rule on purpose,
  // because those are too noisy and a gate people learn to override has already stopped working.
  // Measured over this tree and its whole history: 0 matches, so the noise cost here is nil.
  ['singapore address', /\bSingapore\s*\d{6}\b|#\d{2}-\d{2,5}\b/gi],
  // Infra detail is not PII but is equally unpublishable, and the email rule only catches it
  // by accident (root@<ip> happens to look like an address). Loopback excluded on purpose:
  // 127.0.0.1 is a legitimate stub target in scripts/test-run-sh.sh.
  // The full dotted quad is required, not a leading `10.` — that form matched 14 semvers in
  // package-lock.json.
  ['private network address',
    /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g],
];

// Throws rather than defaults. `const { literals = [] }` meant that renaming the key by one
// character — `literal`, `Literals`, a stray comma dropping it — applied ZERO rules and printed
// `clean — N tracked file(s), 0 literal rule(s) applied`. That line is byte-identical to a
// legitimate CI run, which has no private.local.json at all, so the one signal that could have
// told a disarmed gate from a correctly-empty one was already spent. A file that exists is a
// declaration that rules exist; anything else about it is a bug, and a leak gate reports bugs
// by failing.
function literalRules(root) {
  const path = `${root}/private.local.json`;
  if (!existsSync(path)) return [];
  const { literals } = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(literals)) {
    throw new Error(`${path} exists but has no "literals" array — check the key spelling. `
      + 'Refusing to scan with 0 literal rules, which looks exactly like a clean run.');
  }
  return literals.map((l, i) => {
    if (!l || typeof l.pattern !== 'string' || l.pattern === '') {
      throw new Error(`${path}: literals[${i}] has no "pattern" string`);
    }
    return [`private literal /${l.pattern}/`, new RegExp(l.pattern, l.flags || 'g')];
  });
}

const global_ = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');

// `structural: false` is the self exemption, and it is the ONLY thing that exemption waives.
// See SELF_PATHS below: waiving the literal rules too was a real leak.
export function scanText(text, extraRules = [], { structural = true } = {}) {
  const hits = [];
  if (structural) {
    for (const [rule, re] of STRUCTURAL) {
      for (const m of text.matchAll(global_(re))) {
        if (ALLOWED.some((ok) => ok.test(m[0]))) continue;
        hits.push({ rule, match: m[0] });
      }
    }
  }
  // ALLOWED deliberately does NOT apply here. A literal rule is a hand-authored "always
  // flag this string" declaration; the placeholder vocabulary the redactor substitutes IN
  // (testuser, testuser@example.com, TEST POT) is the same shape ALLOWED waves through, so
  // sharing the allowlist would silently disarm the maintainer's own rules.
  for (const [rule, re] of extraRules) {
    for (const m of text.matchAll(global_(re))) hits.push({ rule, match: m[0] });
  }
  return hits;
}

// Every git call is pinned to the repo root. Run from a subdirectory, a bare `git ls-files`
// returns only that subtree and private.local.json is not found — the scanner would report
// clean and exit 0 having looked at a fraction of the repo.
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 ** 3 });

export const repoRoot = () =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// The scanner's own source contains every pattern it looks for, and its test contains
// deliberate positives. Skipping them is not a loophole: both are reviewed by definition,
// and without this the gate can never go green.
//
// Exempt by CONTENT, never by path. This used to be a set of two paths, and allRevBlobs()
// applied it to --all-revs as well, so the exemption covered not "the reviewed version" but
// every version of those paths that has ever existed, forever. Scanning the 14 historical blobs
// with the exemption lifted turns up 153 structural hits the gate could never report. All 153
// are deliberate synthetic test positives today; the point is that a path cannot know that, and
// the next revision to land is exempt before anyone has read it.
//
// STRUCTURAL rules only. The exemption used to waive every rule, literal ones included, and that
// is the one thing it cannot afford to waive: a literal rule is a hand-authored "always flag this
// string", and these two files are the likeliest in the tree to quote one — the gate has to name
// the shapes it looks for, and its test has to hold examples. A private host's name sat in both
// from the publication commit and was reported for the first time when an unrelated edit broke
// the hash match, i.e. the blind spot was permanent for exactly the version being published.
// Waiving structural stays right: this file quotes every shape it looks for, by necessity.
//
// `private.example.json` used to be here and must not be. It is the template whose whole purpose
// is to hold a person's real name, email and account nicknames, one typo away from the gitignored
// file that really does hold them -- the single worst path in the tree to exempt. The exemption
// also bought nothing: the shipped version produces no structural hit, which is now asserted
// rather than assumed.
const SELF_PATHS = new Set(['scripts/scan-pii.js', 'test/scan-pii.test.js']);
const contentHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Past versions of those two files, each read once and confirmed to hold synthetic positives
// only. TO REFRESH after a legitimate edit: commit it, then run the gate. The old version stops
// matching the working-tree copy, is scanned like any other blob, and prints its own sha256 next
// to its findings — review those findings, then paste the hash here. It fails loudly and it
// cannot go stale in the dangerous direction: a hash that matches nothing exempts nothing.
const SELF_REVIEWED = new Set([
  '9efc536aaab83f1062bc73446e009ca6a7f08e6d7bdc6f6dc09c217934fe4835', // 4a96006 scripts/scan-pii.js
  '81084ad7872557648f6a8d4fa70ee066df1772b4310c0d35338ecda6960c9f82', // 1d028ab scripts/scan-pii.js
  '148e7937559f44ff57ac035405a9d72296bace4834b04efb54cacc7e6337ed57', // 05db2d9 scripts/scan-pii.js
  'cfbe47a3b3f54c6904742bcb367d062f7568d6774d0fde0d83be5e2dcb8dbe7c', // a5eff0a scripts/scan-pii.js
  '40776ad5e351b7081d3f543474f055f86a6e5bc154bf069e9d046bc8002086ca', // 611e78a scripts/scan-pii.js
  '247e27129066cf31265c6a2ad7c66d4abb28c93baa4d592c33966835ce2127a5', // 2835e61 test/scan-pii.test.js
  '93b41469dad920b9250fe7500bc32966d0f8cb25b1278b2ace27f4b67091b348', // 017c78a test/scan-pii.test.js
  'a3b79152114edab0a6c219218c85291bbbc0fbafc0b59b60c0d936dc70275ce4', // 2ac6178 test/scan-pii.test.js
  '02dd351b55b9649db7b01fe2c3f6a412e0f5b170a3ec73165ec9e1af4d209e4c', // bff8a1b test/scan-pii.test.js
  'cc3d8a133dbc551d07b3516902ca5e47b9c4403b5d58688d0aa752224de16c19', // ba9f140 test/scan-pii.test.js
  'a4c9ee2c019cc157d88fb02bbaa0f24f86b76792ab8aecf2dcf510717b44dc46', // 959a78a test/scan-pii.test.js
  '7c0df7db14bcbb2e547bd4c4646883c39308786f906483c2c91956761bc097d6', // ac42263 test/scan-pii.test.js
  '6e00761c5c9a6cdf6e9bdb5b344d2a8d87ecfbd69cd475c2c9b250ec071e4d0b', // b04e799 test/scan-pii.test.js
  'b862a9ba7339e32c18076bc3c4a1ab4aabbb6952f16544acfc0f7cc519866dbc', // 721219f test/scan-pii.test.js
]);

// The working-tree copy is the version under review, so it is exempt without being listed —
// which is also why no hash in the list above can be this file's own, and why the list cannot
// need updating in the same commit that changes the file it protects.
const currentSelfHashes = (root) => new Set(
  [...SELF_PATHS]
    .filter((p) => existsSync(`${root}/${p}`))
    .map((p) => contentHash(readFileSync(`${root}/${p}`, 'utf8'))),
);

// The ONLY skip: a path whose extension cannot carry a readable leak. Decided from the name, so
// no byte of content can talk the gate out of scanning a file.
//
// One NUL byte anywhere in a file used to make the gate skip it silently while still counting it
// as scanned -- so a tracked fixture with a stray NUL, a staged budget SQLite, a raw .eml or a
// .gz went unread and the run still printed `clean` and exited 0. That is exactly the fail-open
// this file's own header forbids: anything it cannot read, cannot resolve, or cannot decide is a
// finding, never a skip.
const BINARY_OK = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp4|mp3|wasm|so|dylib|dll|node)$/i;

// NOT skipped: reported, by name, as something the gate could not read. `pdf`, `zip`, `gz` and
// `tgz` used to sit in BINARY_OK and were skipped in silence — `statements/apr-2026.pdf`,
// `harvest-out/mail.zip` and `backup/budget.sqlite.gz` each scanned clean and exited 0, and the
// docs say harvest-out/ holds UNREDACTED mail. An image cannot carry a greppable leak; an
// archive is a whole tree of them and a PDF is a statement. Calling those "definitely not PII"
// was the exact fail-open this file's header forbids.
const UNSCANNABLE = /\.(pdf|zip|gz|tgz|7z|rar|tar|xz|bz2|sqlite\d?|db|eml|msg|xlsx?|docx?)$/i;

// -z, not plain ls-files: with core.quotePath on (the default) git C-quotes any path that is
// non-ASCII or contains " \ or a control char, emitting the literal 18 characters
// "caf\303\251.md". readFileSync then throws ENOENT and the file goes unscanned. -z emits
// raw bytes NUL-separated, so no quoting exists to undo.
function workingTreeFiles(root) {
  return git(root, ['ls-files', '-z']).split('\0').filter(Boolean)
    .map((path) => ({ path, read: () => readFileSync(`${root}/${path}`, 'utf8') }));
}

// Every blob in every revision, deduplicated by sha — a file unchanged across 30 commits
// is read once, not thirty times. `rev-list --objects` emits trees too, so types are
// resolved in one batch-check rather than by guessing from the path.
// `cat-file --batch-check` reads shas on stdin; feeding it the whole list keeps it to one
// process instead of one per object.
function typesFor(root, shas) {
  return execFileSync('git', ['-C', root, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
    { input: shas.join('\n'), encoding: 'utf8', maxBuffer: 1024 ** 3 });
}

function allRevBlobs(root) {
  const lines = git(root, ['rev-list', '--objects', '--all']).split('\n').filter(Boolean);
  const named = lines.map((l) => {
    const i = l.indexOf(' ');
    return i < 0 ? null : { sha: l.slice(0, i), path: l.slice(i + 1) };
  }).filter(Boolean);

  const types = typesFor(root, named.map((n) => n.sha))
    .split('\n').filter(Boolean)
    .reduce((m, l) => { const [sha, t] = l.split(' '); return m.set(sha, t); }, new Map());

  const seen = new Set();
  return named
    .filter(({ sha }) => types.get(sha) === 'blob' && !seen.has(sha) && seen.add(sha))
    .map(({ sha, path }) => ({ path: `${sha.slice(0, 7)}:${path}`, read: () => git(root, ['cat-file', 'blob', sha]) }));
}

// Commit metadata is history too, and --all-revs is the evidence that a rewritten history is
// clean. Blobs alone leave that claim blind to a leak in a message, and message-only left it
// blind to the author and committer identities — which is the whole point of the rewrite, so
// the gate would have gone green whether or not the reauthoring actually ran.
// Author AND committer, because a rebase or an amend can rewrite one and leave the other.
// NUL-terminated because a commit can contain anything except a NUL byte.
function commitMessages(root) {
  return git(root, ['log', '--all', '--format=%H%n%an <%ae>%n%cn <%ce>%n%B%x00']).split('\0')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter((entry) => entry.trim())
    .map((entry) => {
      const nl = entry.indexOf('\n');
      const sha = nl < 0 ? entry : entry.slice(0, nl);
      const body = nl < 0 ? '' : entry.slice(nl + 1);
      return { path: `${sha.slice(0, 7)}:(commit metadata)`, read: () => body };
    });
}

// pathToFileURL, not a hand-built `file://` string: on Windows the hand-built form is
// `file://C:/…` against import.meta.url's `file:///C:/…`, so the gate would silently
// never run and exit 0 — a leak gate that passes by doing nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const allRevs = process.argv.includes('--all-revs');
  const root = repoRoot();
  const rules = literalRules(root);
  const targets = allRevs ? [...allRevBlobs(root), ...commitMessages(root)] : workingTreeFiles(root);
  const reviewed = currentSelfHashes(root);
  let findings = 0;
  let scanned = 0;

  for (const { path, read } of targets) {
    const bare = path.replace(/^[0-9a-f]{7}:/, '');
    // Decided from the name, so no byte of content can talk the gate out of scanning a file.
    // A NUL byte used to mean "skip this file", which made one stray byte enough to hide a whole
    // file from the gate while still counting it as scanned. Nothing about a NUL prevents
    // scanning text -- src/row.js contains one on purpose, as the row id's separator.
    if (UNSCANNABLE.test(bare)) {
      console.error(`${path}: [unscannable] this gate reads text — extract it and scan the contents`);
      findings += 1;
      continue;
    }
    if (BINARY_OK.test(bare)) continue;
    let text;
    try {
      text = read();
    } catch (err) {
      // Fail closed. "I could not open this" is not "this is clean".
      console.error(`${path}: [unreadable] ${err.code || err.message} — cannot verify`);
      findings += 1;
      continue;
    }
    const hash = contentHash(text);
    if (SELF_REVIEWED.has(hash)) continue;
    // The version under review: structural waived, literal rules still applied. See SELF_PATHS.
    const selfExempt = reviewed.has(hash);
    // An unreviewed revision of the gate or its test. Named with its hash so the findings below
    // can be read once and the hash pasted into SELF_REVIEWED — see the comment there.
    if (SELF_PATHS.has(bare) && !selfExempt) {
      console.error(`${path}: unreviewed version of the gate, sha256 ${hash}`);
    }
    scanned += 1;
    for (const hit of scanText(text, rules, { structural: !selfExempt })) {
      console.error(`${path}: [${hit.rule}] ${hit.match}`);
      findings += 1;
    }
  }

  // Counts what was actually read, not what was listed — the two diverged during the
  // quotePath bug and the summary line cheerfully reported files it had never opened.
  const scope = allRevs
    ? `${scanned} blob(s) and commit message(s) across all revisions`
    : `${scanned} tracked file(s)`;
  if (findings) {
    console.error(`\n${findings} finding(s) in ${scope}`);
    process.exit(1);
  }
  console.log(`clean — ${scope}, ${rules.length} literal rule(s) applied`);
}
