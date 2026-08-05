// One retry policy for both sources, because the fault is the resolver and not either
// service. Three DNS blips inside 36 hours: 2026-08-01 11:15 and 2026-08-02 17:15 on
// imap.gmail.com, 2026-08-01 23:15 on api.transferwise.com. Each time the OTHER source
// resolved fine in the same run, and the loader's container-DNS calls never failed at all —
// so this is a per-query blip to ride out, not an outage to re-plumb DNS for. Every candidate
// cause upstream of the host resolver was ruled out by measurement rather than by argument,
// and an encrypted-DNS proxy had already been tried and reverted for breaking something else.
//
// Those three are the ones still attributable. run.log carries 12 extract failures across
// 100 runs but records only THAT extract failed, never why — the reason lives in the alert
// body, which is not kept. The other nine all fall in 2026-07-29..07-31, while the parsers
// and the alerting were themselves being changed, so do not read them as nine more blips.
//
// Wise already retried 3 times 1s apart and still lost the 23:15 run, which is exactly the
// upgrade trigger its old comment named: "raise the counts only if the log shows blips
// outliving 2 seconds". IMAP had no retry at all, so one blip on connect() failed the source
// outright. Fixing it in one source would have left the other falling over on the same blip,
// so the policy lives here and both call sites use it.
//
// ponytail: fixed 1s/2s/4s, no jitter — one process making one query at a time has no
// thundering herd to spread out. Raise ATTEMPTS if run.log shows blips outliving ~7s.
export const ATTEMPTS = 4;
const BASE_MS = 1000;

// Retrying a wrong password four times is how an IMAP account gets locked, so only a
// transport-level fault counts as transient. ENOTFOUND is in the list: these hostnames come
// from config and do not move, so an NXDOMAIN for imap.gmail.com is the resolver failing
// rather than a typo — and a genuine typo is still reported, just seven seconds later.
const TRANSIENT = /\b(EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b/;

// The code can arrive on the error, on its cause (undici buries a SystemError inside
// `TypeError: fetch failed`), or in the message only — imapflow's connect failure is the one
// actually observed and all it gave us was "getaddrinfo EAI_AGAIN imap.gmail.com", so the
// message is checked too rather than trusting every layer to set .code.
export function isTransient(err) {
  for (let e = err, depth = 0; e && depth < 3; e = e.cause, depth += 1) {
    if (TRANSIENT.test(String(e.code ?? '')) || TRANSIENT.test(String(e.message ?? ''))) return true;
  }
  return false;
}

export async function retry(fn, { attempts = ATTEMPTS, baseMs = BASE_MS, retryIf = isTransient } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !retryIf(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (attempt - 1)));
    }
  }
}
