---
'@noblecloak/langgraph': minor
---

Reads `continuation_kinds` from `GET /v1/capabilities` (contract rev 17). When a deployment routes approvals and lists the continuation kinds it accepts without `langgraph`, the adapter now refuses to start with the new `continuation_kind_unsupported` error, at `assertReady()`, `runResumer` start-up and the first governed call, instead of opening approvals that can never resume. A deployment that lists no kinds is used as before. Depends on `@noblecloak/client` 0.13.0 (contract rev 18).
