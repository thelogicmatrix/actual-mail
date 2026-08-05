import { COLUMNS } from './row.js';

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows) {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvField(row[c])).join(','));
  return lines.join('\n') + '\n';
}

// Zero rows is zero bytes. `run.sh` reads emptiness (`[ -s ]`) as "nothing was extracted" and
// leaves the day's archive alone; a bare '\n' looked like a row to it and would have moved a
// blank line over a good archive. CSV is deliberately different — a header-only file is still
// a valid, readable CSV — and run.sh does not use that format.
export function toJsonl(rows) {
  return rows.length === 0 ? '' : rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
