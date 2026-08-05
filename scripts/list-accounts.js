// Developer tool. Read-only: lists open Actual accounts so mapping.json can be written
// with real ids instead of guesses.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';

const dataDir = process.env.ACTUAL_DATA_DIR
  ?? fileURLToPath(new URL('../.actual-cache', import.meta.url));
mkdirSync(dataDir, { recursive: true });

await api.init({
  dataDir,
  serverURL: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,
});
try {
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID, {
    password: process.env.ACTUAL_BUDGET_PASSWORD,
  });
  for (const a of await api.getAccounts()) {
    if (!a.closed) console.log(`${a.id}  ${a.offbudget ? 'off' : 'on '}  ${a.name}`);
  }
} finally {
  await api.shutdown();
}
