---
'@workflow/web-shared': patch
'@workflow/cli': patch
---

Show a run's start Hook token and revive `WorkflowStartError` and `HookReservedError`; CLI re-runs never forward a start Hook. Upgrade dashboards and CLIs before or with the SDK: older ones show the two new errors, which now appear in failed steps and runs, as an unknown type.
