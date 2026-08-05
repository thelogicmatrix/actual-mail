// Developer tool. Establishes empirically which Wise endpoints the personal token can
// reach and whether the statement endpoint demands SCA (a signed x-2fa-approval flow).
// Prints status codes and header names only - never a token, never account numbers.
const TOKEN = process.env.WISE_API_TOKEN;
if (!TOKEN) { console.error('WISE_API_TOKEN not set'); process.exit(1); }

const BASE = 'https://api.transferwise.com';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function probe(label, path) {
  const res = await fetch(BASE + path, { headers: H });
  const scaHeader = res.headers.get('x-2fa-approval');
  const scaStatus = res.headers.get('x-2fa-approval-result');
  console.log(`${String(res.status).padEnd(4)} ${label}`);
  if (scaHeader) console.log(`     SCA REQUIRED: x-2fa-approval present, result=${scaStatus}`);
  if (!res.ok) {
    const body = await res.text();
    console.log(`     body: ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
    return null;
  }
  return res.json();
}

const profiles = await probe('GET /v1/profiles', '/v1/profiles');
if (!profiles) process.exit(1);

// Shape only - no names, no ids beyond what is needed to continue probing.
console.log(`     profiles: ${profiles.map((p) => p.type).join(', ')}`);
const personal = profiles.find((p) => p.type === 'personal') ?? profiles[0];

const balances = await probe(`GET /v4/profiles/{id}/balances`,
  `/v4/profiles/${personal.id}/balances?types=STANDARD`);
if (balances) {
  console.log(`     balances: ${balances.map((b) => b.currency).join(', ')}`);
  const b = balances[0];
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 30 * 864e5).toISOString();
  const stmt = await probe('GET balance-statements/{id}/statement.json',
    `/v1/profiles/${personal.id}/balance-statements/${b.id}/statement.json`
    + `?currency=${b.currency}&intervalStart=${start}&intervalEnd=${end}&type=COMPACT`);
  if (stmt) {
    console.log(`     transactions: ${stmt.transactions?.length ?? 0}`);
    const t = stmt.transactions?.[0];
    if (t) console.log(`     first txn keys: ${Object.keys(t).join(', ')}`);
  }
}
