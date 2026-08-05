import { makeRow } from '../row.js';
import { retry, ATTEMPTS } from '../retry.js';

const BASE = 'https://api.transferwise.com';

// Pure transform — no network, so this is where the correctness weight sits.
export function wiseRows(statement, accountLabel) {
  return (statement.transactions ?? []).map((t) => makeRow({
    source: 'wise',
    account: accountLabel,
    date: new Date(t.date).toISOString(),
    // The only float->string conversion in the codebase, confined to the boundary where
    // Wise hands us a JSON number we do not control.
    amount: t.amount.value.toFixed(2),
    currency: t.amount.currency,
    payee: t.details?.description ?? '(no description)',
    type: t.amount.value < 0 ? 'transfer_out' : 'transfer_in',
    rawRef: t.referenceNumber,
  }));
}

// A network-level failure is a rejection, not a response, so none of the res.ok handling
// below ever sees it. On 2026-07-29 the LAN resolver returned EAI_AGAIN for one query and
// Node threw `TypeError: fetch failed` out of the whole run. That class of failure — DNS
// blip, dropped connection — is transient by definition, so it is worth asking again. The
// window is shared with the IMAP source and now widens per attempt; see src/retry.js for why
// three tries one second apart turned out not to be enough on 2026-08-01.
//
// HTTP errors are deliberately NOT retried: a 403 IP allowlist or a 500 does not heal in a
// second, and retrying only delays the report of a real problem.
async function get(token, path) {
  const res = await retry(() => fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }), {
    // The callback holds nothing but the fetch, and fetch rejects only on a transport fault —
    // an HTTP error comes back as a response and is handled below. So every rejection reaching
    // here is network, whether or not undici bothered to attach a code to it.
    retryIf: () => true,
  }).catch((cause) => {
    // The raw undici stack is 20 unreadable lines in a Discord alert. Say what broke.
    throw new Error(
      `Wise unreachable after ${ATTEMPTS} attempts on ${path}: ${cause.message}`
      + `${cause.cause?.code ? ` (${cause.cause.code})` : ''}`, { cause });
  });
  if (!res.ok) {
    // A 403 here is almost always the token's IP allowlist: Wise only accepts calls from the
    // address the token is allowlisted to, so a dev machine gets 403 where production gets 200.
    const hint = res.status === 403
      ? ' (403 is usually the token IP allowlist; Wise only accepts calls from the allowlisted address)'
      : '';
    throw new Error(`Wise ${res.status} on ${path}${hint}`);
  }
  return res.json();
}

export async function fetchWise({ token, since, until }) {
  if (!token) throw new Error('WISE_API_TOKEN is not set');

  const profiles = await get(token, '/v1/profiles');
  const profile = profiles.find((p) => p.type === 'personal') ?? profiles[0];
  if (!profile) throw new Error('Wise returned no profiles');

  const balances = await get(token, `/v4/profiles/${profile.id}/balances?types=STANDARD`);

  const intervalStart = new Date(since).toISOString();
  const intervalEnd = new Date(until ?? Date.now()).toISOString();

  const rows = [];
  // Every balance, not just the first: the account holds AUD, SGD and USD, and fetching
  // one would silently drop two currencies' transactions.
  for (const balance of balances) {
    const statement = await get(token,
      `/v1/profiles/${profile.id}/balance-statements/${balance.id}/statement.json`
      + `?currency=${balance.currency}&intervalStart=${intervalStart}`
      + `&intervalEnd=${intervalEnd}&type=COMPACT`);
    rows.push(...wiseRows(statement, `wise-${balance.currency.toLowerCase()}`));
  }
  return rows;
}
