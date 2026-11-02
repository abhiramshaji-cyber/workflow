---
"@workflow/core": patch
---

Record a step's retry or failure right away when the step throws a thenable that never settles or keeps resolving to itself, or an error whose cause cannot be serialized, instead of losing the event and waiting for queue redelivery. A thrown thenable gets up to 10 seconds to settle (`WORKFLOW_THROWN_THENABLE_TIMEOUT_MS`), and the fallback for an unserializable error keeps its cause chain and `AggregateError` members as plain errors.
