import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../scripts/scan-pii.js';

const SCANNER = fileURLToPath(new URL('../scripts/scan-pii.js', import.meta.url));

test('flags a real-looking email address', () => {
  const hits = scanText('contact someone@gmail.com for details');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'email address');
});

test('allows example.com addresses — the redactor is supposed to leave those', () => {
  assert.deepEqual(scanText('contact testuser@example.com'), []);
});

test('flags an un-redacted account number', () => {
  const hits = scanText('from A/C ending 4821 to');
  assert.equal(hits[0].rule, 'account number');
});

test('allows the redacted account placeholder', () => {
  assert.deepEqual(scanText('from A/C ending 0000 to'), []);
});

test('flags a merchant-shaped string with a country suffix', () => {
  const hits = scanText('spent SGD 12.34 at COLD STORAGE SG on 1 Feb 2026');
  assert.equal(hits[0].rule, 'merchant + country');
});

// The rule knew nine country codes — the nine that appeared in one person's own statements.
// Fed the same line across fifteen codes, only SG and US flagged: MY, JP, AU, TH, CN, IN, FR,
// KR, PH, VN, TW, CH and CA all scanned clean, and the first four of those are where a
// Singapore cardholder most often transacts abroad. A contributor in Kuala Lumpur committing
// `AEON TAMAN MALURI MY` was told the fixture was clean.
test('any two-letter country code counts, not a list of nine', () => {
  for (const cc of ['SG', 'US', 'MY', 'JP', 'AU', 'TH', 'CN', 'IN', 'FR', 'KR', 'PH', 'VN', 'TW', 'CH', 'CA']) {
    const hits = scanText(`spent SGD 12.34 at GRAB HOLDINGS ${cc} on 1 Feb 2026`);
    assert.equal(hits.length, 1, `expected ${cc} to be flagged`);
    assert.equal(hits[0].rule, 'merchant + country');
  }
});

// The measured cost of that widening: twelve all-caps prose spans in this tree, eight of them
// the MIT licence. Allowed by exact text and anchored at both ends, so none of them can swallow
// a real merchant sharing its span — the failure a prefix-style entry caused once already.
test('the measured all-caps prose false positives are allowed, and cannot swallow a merchant', () => {
  assert.deepEqual(scanText('THE SOFTWARE IS provided as is'), []);
  assert.deepEqual(scanText('WITHOUT WARRANTY OF any kind'), []);
  const hits = scanText('DAMAGES OR COLD STORAGE SG');
  assert.equal(hits.length, 1, 'a prose allowance must not cover the merchant beside it');
  assert.equal(hits[0].rule, 'merchant + country');
});

test('allows the TEST MERCHANT placeholder', () => {
  assert.deepEqual(scanText('spent SGD 12.34 at TEST MERCHANT SG on 1 Feb 2026'), []);
});

test('a clean string produces no findings', () => {
  assert.deepEqual(scanText('the quick brown fox jumps over the lazy dog'), []);
});

// Regression: the merchant character class contains a space, so one match can span a
// placeholder AND a real merchant. A prefix-style allowlist then suppressed the whole span,
// and a half-redacted line — one merchant replaced, the next missed — scanned clean.
test('a placeholder does not swallow a real merchant sharing its match', () => {
  const hits = scanText('at TEST MERCHANT AND COLD STORAGE SG here');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'merchant + country');
});

test('a placeholder does not swallow a real merchant that follows it', () => {
  const hits = scanText('at TEST POT COLD STORAGE SG here');
  assert.equal(hits.length, 1);
});

// The rule was Trust's exact wording, `ending \d{4}`, and every other bank's spelling of the
// same identifier walked straight through — the word "in" alone was enough to defeat it. For a
// project whose CONTRIBUTING asks strangers for their own bank mail, the one wording it knew
// was the one bank that already had a parser.
test('flags the account-number spellings other banks use', () => {
  for (const s of ['Your card ending in 4829', 'Card **** 4829', 'Acct xxxx4829',
    'last 4 digits: 4829', 'Account 0123456789 debited', 'from A/C ending 4821 to']) {
    const hits = scanText(s).filter((h) => h.rule === 'account number');
    assert.equal(hits.length, 1, `expected an account-number hit in: ${s}`);
  }
});

// The other half of that widening: the gap between the word and the digits admits separators,
// masking and connector words, never arbitrary text. `[^\d]{0,16}` also matched `card', date:
// '2026` in a test file, and a rule that flags a date literal is one people learn to override.
test('a keyword followed by unrelated prose and a year is not an account number', () => {
  for (const s of ["{ account: 'card', date: '2026-08-01T12:00:00+08:00' }",
    'no Actual account mapped for "wise-sgd" in 2026']) {
    assert.deepEqual(scanText(s).filter((h) => h.rule === 'account number'), [], s);
  }
});

// An IBAN carries a whole account in one token, and no other rule here can see one.
test('flags an IBAN', () => {
  const hits = scanText('transfer to IBAN GB29NWBK60161331926819 today');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'bank account (IBAN)');
});

// A postcode is a building and the unit number is the front door. Only these two shapes: a
// free-text street rule is too noisy to survive, and a gate people override has stopped working.
test('flags a Singapore postcode and unit number, not the street line', () => {
  const hits = scanText('12 Bukit Batok West Ave 5, #08-123, Singapore 650123');
  assert.equal(hits.length, 2);
  assert.deepEqual([...new Set(hits.map((h) => h.rule))], ['singapore address']);
});

test('flags a Singapore NRIC/FIN', () => {
  const hits = scanText('NRIC S1234567D on file');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'singapore NRIC/FIN');
});

// Same identifier, same leak. The rule had no `i`, so a lowercase log line passed.
test('an NRIC in lowercase is the same identifier', () => {
  const hits = scanText('nric s1234567d on file');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'singapore NRIC/FIN');
});

test('flags a Singapore phone number in both forms', () => {
  assert.equal(scanText('call +65 9123 4567 now')[0].rule, 'singapore phone');
  assert.equal(scanText('call 91234567 now')[0].rule, 'singapore phone');
});

// A literal rule is a hand-authored "always flag this". The redactor's own replacement
// vocabulary (TEST POT, testuser@example.com) is exactly what ALLOWED waves through, so
// sharing the allowlist with literal rules would silently disarm them.
test('the allowlist does not suppress a literal rule', () => {
  const hits = scanText('the TEST POT balance', [['private literal /TEST POT/', /TEST POT/g]]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, 'TEST POT');
});

// A noreply address is the anonymised form of an identity, not a leak, and the history
// rewrite reauthors commits to @users.noreply.github.com. Anchored, so an address that
// merely contains the word is still caught — that shape is trivially forgeable.
test('noreply addresses are allowed, lookalikes are not', () => {
  assert.deepEqual(scanText('Co-Authored-By: Someone <noreply@anthropic.com>'), []);
  assert.deepEqual(scanText('author 12345+user@users.noreply.github.com committed'), []);
  const hits = scanText('contact leak+noreply@example-bank.com now');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'email address');
});

// `^noreply@` pinned the local part and left the DOMAIN free, justified as "the local part is
// the payload". True for an identity and false for infrastructure, which this gate says is
// equally unpublishable — a private hostname rode out on a noreply address and published fine.
test('a private hostname on a noreply address is still a leak', () => {
  const hits = scanText('from noreply@vault-host.internal.example-corp.net');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule, 'email address');
});

// Infra detail is not PII but is equally unpublishable. Before this rule it was caught only
// by accident, where an ssh target of the form root@<ip> happened to satisfy the email regex
// — delete the `root@` and the same address shipped silently.
// The 192.168 representative is deliberately NOT the maintainer's own subnet: Task 10's
// history rewrite maps that subnet to a documentation address, and this file is only exempt
// from the SCANNER, not from filter-repo. A real-subnet literal here would be rewritten to a
// public address and this assertion would then demand the rule flag one, which it must not.
test('flags private and CGNAT network addresses', () => {
  for (const ip of ['10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.254', '100.64.0.1']) {
    const hits = scanText(`host ${ip} here`);
    assert.equal(hits.length, 1, `expected ${ip} to be flagged`);
    assert.equal(hits[0].rule, 'private network address');
    assert.equal(hits[0].match, ip);
  }
});

// The measured non-matches. Loopback is excluded deliberately — it is a legitimate stub
// target — and the full dotted quad is required because a bare `10.` form matched 14 semvers
// in package-lock.json.
test('does not flag loopback, public, or partial addresses', () => {
  for (const s of ['127.0.0.1', '10.0.0', '1.2.3.4', '8.8.8.8', '100.200.1.1']) {
    assert.deepEqual(scanText(`host ${s} here`), [], `expected ${s} not to be flagged`);
  }
});

// The CLI tests below each get a throwaway repo. Nothing here may touch this project's own
// working tree: a test that scanned the real repo would be scanning real PII, and its
// pass/fail would drift with unrelated commits.
function inTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-pii-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    return fn(dir, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runScanner = (cwd, ...args) =>
  spawnSync(process.execPath, [SCANNER, ...args], { cwd, encoding: 'utf8' });

// Regression: with core.quotePath on (the default) `git ls-files` emits non-ASCII paths
// C-quoted, readFileSync threw ENOENT, and the bare catch swallowed it — a repo whose only
// leak lived in such a file scanned clean and exited 0.
test('a tracked file with a non-ASCII name is scanned, not silently skipped', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'café.md'), 'contact someone@gmail.com for details\n');
    git('add', '-A');

    const run = runScanner(dir);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);
    assert.match(run.stderr, /someone@gmail\.com/);
    assert.match(run.stderr, /caf/);
    // Not merely failing closed — it actually read the file.
    assert.doesNotMatch(run.stderr, /unreadable/);
  });
});

// The counterpart to the above: the CLI must be runnable from anywhere and still see the
// whole repo. From a subdirectory a bare `git ls-files` returns only that subtree.
test('running from a subdirectory still scans the whole repo', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'leak.md'), 'contact someone@gmail.com for details\n');
    git('add', '-A');
    const sub = join(dir, 'sub');
    mkdirSync(sub);

    const run = runScanner(sub);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);
    assert.match(run.stderr, /someone@gmail\.com/);
  });
});

// Fail closed, asserted positively. A tracked path that cannot be opened is a finding:
// "I could not look at this" is not "this is clean". Staged-then-deleted is the cheapest
// portable way to produce one — ls-files still lists it, the working tree does not have it.
test('an unreadable tracked path is reported as a finding', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'gone.md'), 'nothing to see here\n');
    git('add', '-A');
    rmSync(join(dir, 'gone.md'));

    const run = runScanner(dir);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /gone\.md: \[unreadable\] ENOENT/);
    assert.match(run.stderr, /1 finding\(s\)/);
  });
});

// --all-revs is Task 10's evidence that a rewritten history is clean, and a commit message
// is part of history. Blobs alone leave that claim blind.
test('--all-revs reports a leak that exists only in a commit message', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'clean.md'), 'nothing to see here\n');
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T',
      'commit', '-q', '-m', 'chore: ping someone@gmail.com about the import');

    // The working tree alone is clean — proving the finding comes from the message.
    assert.equal(runScanner(dir).status, 0);

    const run = runScanner(dir, '--all-revs');
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /\(commit metadata\): \[email address\] someone@gmail\.com/);
    assert.match(run.stderr, /1 finding\(s\)/);
  });
});

// The rewrite in Task 10 reauthors commits, and --all-revs going green is its only evidence
// that it happened. Scanning the message alone made that evidence worthless: the gate would
// pass whether or not the reauthoring ran. Author and committer are asserted separately
// because a rebase or an amend can rewrite one and leave the other behind.
test('--all-revs reports commit author and committer identity', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'clean.md'), 'nothing to see here\n');
    git('add', '-A');
    git('-c', 'user.email=committer@gmail.com', '-c', 'user.name=C',
      'commit', '-q', '--author=Author Person <author@gmail.com>', '-m', 'chore: initial');

    assert.equal(runScanner(dir).status, 0);

    const run = runScanner(dir, '--all-revs');
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /\(commit metadata\): \[email address\] author@gmail\.com/);
    assert.match(run.stderr, /\(commit metadata\): \[email address\] committer@gmail\.com/);
  });
});

// --- the two ways the gate could be talked out of looking at a file ----------------------

// A NUL byte used to mean "skip this file", while still counting it as scanned. One stray byte
// therefore hid a whole file from the gate and the run printed clean and exited 0 -- the exact
// fail-open this file's header forbids. src/row.js carries a NUL on purpose (the row id's
// separator), so a NUL is not even evidence of a binary.
test('a text file containing a NUL byte is still scanned', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'fixture.txt'), 'S7654321A other.person@gmail.com\u0000 trailing\n');
    git('add', '-A');
    const run = runScanner(dir);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);
    assert.match(run.stderr, /other\.person@gmail\.com/);
    assert.match(run.stderr, /S7654321A/);
  });
});

// `.pdf`, `.zip` and `.gz` used to sit in the skip list and were passed over in SILENCE, with
// no output and no count -- the exact fail-open the scanner's own header forbids. A zipped
// harvest-out/ is the one the docs say holds unredacted mail.
test('an archive or a PDF is a finding, not a silent skip', () => {
  inTempRepo((dir, git) => {
    mkdirSync(join(dir, 'statements'));
    writeFileSync(join(dir, 'statements/apr-2026.pdf'), 'PDF-ish bytes');
    writeFileSync(join(dir, 'mail.zip'), 'PKzip bytes');
    writeFileSync(join(dir, 'budget.sqlite.gz'), 'gzip bytes');
    git('add', '-A');

    const run = runScanner(dir);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /apr-2026\.pdf: \[unscannable\]/);
    assert.match(run.stderr, /mail\.zip: \[unscannable\]/);
    assert.match(run.stderr, /budget\.sqlite\.gz: \[unscannable\]/);
    assert.match(run.stderr, /3 finding\(s\)/);
  });
});

// A file that exists but declares nothing used to default to zero rules and print
// `clean — N tracked file(s), 0 literal rule(s) applied`, which is byte-identical to a CI run
// with no file at all. One character in the key disarmed every rule the maintainer has, and the
// one signal that could have told the two apart was already spent.
test('a private.local.json with the key misspelled fails instead of applying nothing', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'clean.md'), 'nothing to see here\n');
    writeFileSync(join(dir, 'private.local.json'),
      '{"literal":[{"pattern":"Some Name"}]}\n');
    git('add', 'clean.md');

    const run = runScanner(dir);
    assert.notEqual(run.status, 0, `expected a failure, got ${run.status}\n${run.stdout}`);
    assert.doesNotMatch(run.stdout, /clean/);
    assert.match(run.stderr, /literals/);
  });
});

test('a literal entry with no pattern fails instead of being skipped', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'clean.md'), 'nothing to see here\n');
    writeFileSync(join(dir, 'private.local.json'), '{"literals":[{"replacement":"x"}]}\n');
    git('add', 'clean.md');

    const run = runScanner(dir);
    assert.notEqual(run.status, 0, `expected a failure, got ${run.status}\n${run.stdout}`);
    assert.match(run.stderr, /literals\[0\]/);
  });
});

// The SELF exemption was two PATHS, and --all-revs applied it too — so it covered not "the
// version under review" but every version of those paths that has ever existed, permanently.
// Exempting by content hash means the current copy is still waved through and a superseded
// revision is scanned like any other blob.
test('a superseded revision of the scanner itself is scanned, not exempt by path', () => {
  inTempRepo((dir, git) => {
    mkdirSync(join(dir, 'scripts'));
    const self = join(dir, 'scripts/scan-pii.js');
    const commit = (msg) => git('-c', 'user.email=t@example.com', '-c', 'user.name=T',
      'commit', '-q', '-m', msg);

    writeFileSync(self, '// v1 leaked: someone@gmail.com\n');
    git('add', '-A');
    commit('chore: v1');
    writeFileSync(self, '// v2 is clean\n');
    git('add', '-A');
    commit('chore: v2');

    // The working-tree copy is the version under review, so the tree alone is still clean.
    assert.equal(runScanner(dir).status, 0);

    const run = runScanner(dir, '--all-revs');
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /scripts\/scan-pii\.js: unreviewed version of the gate, sha256 [0-9a-f]{64}/);
    assert.match(run.stderr, /someone@gmail\.com/);
  });
});

// The exemption waived EVERY rule for the checked-out copy of the gate and its test, so the two
// files most likely to quote a private literal were the two the literal rules could never see.
// One did: a private host's name sat in both from the publication commit and was reported for
// the first time when an unrelated edit broke the hash match. Structural rules stay waived --
// this file necessarily quotes every shape it looks for.
test('the checked-out gate is still checked against literal rules', () => {
  inTempRepo((dir, git) => {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/scan-pii.js'),
      '// deployed on vault-host.private-example.test, ask someone@gmail.com\n');
    writeFileSync(join(dir, 'private.local.json'),
      '{"literals":[{"pattern":"vault-host\\\\.private-example\\\\.test"}]}\n');
    git('add', 'scripts/scan-pii.js');

    const run = runScanner(dir);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /vault-host\.private-example\.test/);
    // Waived, and it has to stay waived: the gate's own source quotes every shape it looks for.
    assert.doesNotMatch(run.stderr, /someone@gmail\.com/);
  });
});

test('a genuine binary is skipped by extension, not by content', () => {
  inTempRepo((dir, git) => {
    // Bytes that would be findings if this were scanned as text.
    writeFileSync(join(dir, 'logo.png'), 'S7654321A\u0000\u0000binary');
    git('add', '-A');
    const run = runScanner(dir);
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stderr}`);
  });
});

// private.example.json was on the SELF exemption list: the one file whose entire purpose is to
// hold a person's real name, email and account nicknames, one typo away from private.local.json.
// Only its filename saved it, in the working tree and in every revision.
test('private.example.json is scanned like any other file', () => {
  inTempRepo((dir, git) => {
    writeFileSync(join(dir, 'private.example.json'),
      '{"literals":[{"pattern":"bernard.tan@gmail.com","replacement":"x"}]}\n');
    git('add', '-A');
    const run = runScanner(dir);
    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);
    assert.match(run.stderr, /bernard\.tan@gmail\.com/);
  });
});

test('the shipped private.example.json is clean, so it needs no exemption', () => {
  // The claim the removed exemption was resting on, now asserted instead of assumed.
  const shipped = readFileSync(new URL('../private.example.json', import.meta.url), 'utf8');
  assert.deepEqual(scanText(shipped), []);
});

// --- an account number with no "ending" beside it ----------------------------------------

test('a four-digit mapping key is flagged as an account number', () => {
  // The real leak: mapping.json keys an account by the last four digits from the alert email, so
  // a bare four-digit key IS an account number here -- and the `ending \d{4}` rule cannot see it.
  // Invented digits. This file is exempt from the SCANNER, not from the history rewrite, and a test
  // fixture is the wrong place to quote a real identifier -- which is exactly what the header of
  // scan-pii.js says, and what this test was breaking on its first draft.
  for (const line of ['{ card: a, main: a, 5678: a }', "{ '4821': uuid }", '  9012: uuid,']) {
    const hits = scanText(line).filter((h) => h.rule === 'account key');
    assert.equal(hits.length, 1, `expected one account-key hit in: ${line}`);
  }
});

test('an all-zero key is the placeholder convention and passes', () => {
  for (const line of ["{ '0000': uuid }", '{ 0000: uuid }']) {
    assert.deepEqual(scanText(line).filter((h) => h.rule === 'account key'), [],
      `all-zero key must pass: ${line}`);
  }
});

test('a prefixed mapping key does not hide an account number from the gate', () => {
  // The mapping's own documented shapes put a prefix in front of the digits, and the rule
  // anchored the digits straight after the opening quote — so every prefixed key was invisible
  // to the one rule that exists to catch a bare account number. `.gitignore` covers the real
  // mapping file, but this is the backstop, and a backstop one shape thinner than the schema it
  // guards is the failure mode the account-key rule was added for in the first place.
  // Invented digits, per the header of scan-pii.js.
  for (const line of ['{ "no-inbound-alert:5678": uuid }', '{ "untracked:5678": null }']) {
    assert.equal(scanText(line).filter((h) => h.rule === 'account key').length, 1,
      `expected one account-key hit in: ${line}`);
  }
});

test('an all-zero key stays the placeholder convention behind a prefix too', () => {
  for (const line of ['{ "no-inbound-alert:0000": uuid }', '{ "untracked:0000": null }']) {
    assert.deepEqual(scanText(line).filter((h) => h.rule === 'account key'), [],
      `all-zero key must pass behind a prefix: ${line}`);
  }
});

test('a stack-trace line number is not an account key', () => {
  // `net.js:1141:16` is four digits followed by a colon. Anchoring the rule to a key position is
  // what keeps this rule usable rather than something people learn to override.
  const trace = '    at TCPConnectWrap.afterConnect (net.js:1141:16)';
  assert.deepEqual(scanText(trace).filter((h) => h.rule === 'account key'), []);
});
