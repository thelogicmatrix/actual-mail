// ECB reference rates via frankfurter.dev — free, no key, no account.
// Requested base-currency-based so one call per date covers every currency.
const API = 'https://api.frankfurter.dev/v1';

export const DEFAULT_MARKUP = 0.003;

// A markup approximates a spread the BANK kept on a conversion the bank performed, which is a
// genuine estimate of a settled figure nobody has told us yet. An API source is not that: Wise
// reports the currency it actually holds, so a USD payment out of a USD balance was never
// converted and no spread was charged. Applying the card markup there booked every such row
// ~0.3% off, systematically, in one direction, forever — a known-zero spread modelled as
// non-zero. The rate itself is still an estimate (ECB mid vs the day's real value), so the row
// keeps its "verify at settlement" note; only the invented spread goes.
//
// ponytail: a set, not per-source env vars. FX_MARKUP stays the knob for alert-derived rows,
// which is the only one that has ever needed tuning. Add a source here when it reports a
// currency it holds rather than a converted charge.
export const NO_SPREAD_SOURCES = new Set(['wise']);

export function markupFor(source, markup = DEFAULT_MARKUP) {
  return NO_SPREAD_SOURCES.has(source) ? 0 : markup;
}

// The base currency is the one your Actual budget is denominated in. Everything else is
// foreign and takes the FX path. Defaults to SGD so the original deployment is unchanged
// by the introduction of this setting.
export function baseCurrency() {
  return process.env.BASE_CURRENCY || 'SGD';
}

// The only network caller on the money path without a retry wrapper, and it had no bound either
// — so a frankfurter socket that accepted the connection and then went quiet would hang the
// loader indefinitely, holding the flock, with nothing to say about it. The watchdog would be
// the first to notice, 90 minutes later. The retry is still deliberately absent (BACKLOG wants a
// range request rather than a wrapper), but a timeout is independent of that work and is one
// argument.
const FX_TIMEOUT_MS = 15_000;

export async function fetchRates(dates, fetchImpl = fetch, base = baseCurrency()) {
  const out = new Map();
  for (const date of new Set(dates)) {
    const res = await fetchImpl(`${API}/${date}?base=${base}`,
      { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`FX rate lookup failed for ${date}: HTTP ${res.status}`);
    const json = await res.json();
    // ECB publishes nothing at weekends or holidays; the response reports which date's
    // rate was actually served, and that goes into the transaction note.
    out.set(date, { rates: json.rates, rateDate: json.date });
  }
  return out;
}

// Returns null for the base currency (nothing to convert) and throws for a currency the
// rate table does not cover — never returns a guessed rate.
export function makeRateLookup(rateMap, markup = DEFAULT_MARKUP, base = baseCurrency()) {
  return (date, currency, source = null) => {
    if (currency === base) return null;
    const entry = rateMap.get(date);
    if (!entry) throw new Error(`no FX rate fetched for ${date}`);
    const inverse = entry.rates?.[currency];
    if (!inverse) throw new Error(`ECB has no ${currency} rate for ${entry.rateDate}`);
    return { rate: 1 / inverse, rateDate: entry.rateDate, markup: markupFor(source, markup) };
  };
}
