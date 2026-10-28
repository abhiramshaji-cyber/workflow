---
'@workflow/world-postgres': minor
---

Support atomic start Hook admission behind `WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK=1`, and make concurrent `createHook()`s of one token leave one owner. Migration `0028_add_start_hook_admissions` is required even with the flag off; every process using the database, readers included, must run this version before you enable it.
