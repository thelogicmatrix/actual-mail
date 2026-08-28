# Session: actual-mail UOB and transfers

Date: 2026-08-28 11:43
Project: actual-mail UOB and transfers

## Changed

- 8b1e063 Merge feat/uob-and-transfers: UOB source and internal-transfer detection

## Decisions

None recorded.

## Next

Ask Nathan whether to add an untracked-source-account mechanism so wise-aud/wise-usd rows are skipped rather than FX-converted into the SGD-only Wise

**Outcome (2026-08-28):** answered yes and built — `untracked:<key>` in `mapping.json`. See
the untracked-source-accounts entry in `docs/DECISIONS.md`. Both `wise-aud` and `wise-usd`
need an entry in the host mapping; the code alone changes nothing. 
