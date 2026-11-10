---
'@noblecloak/langgraph': minor
---

Reads `continuation_kinds` from `GET /v1/capabilities` (contract rev 17). When a deployment routes approvals and lists the continuation kinds it accepts without `langgraph`, the adapter now refuses with the new `continuation_kind_unsupported` error instead of opening approvals that can never resume. `assertReady()`, `runResumer`, `governanceMiddleware` and `governedToolNode` with `handleToolErrors: false` throw it; the default `governedToolNode` reports it to `onError` and gives the model the error message. A deployment that does not advertise `continuation_kinds` is used as before. Depends on `@noblecloak/client` 0.13.0 (contract rev 18). `runs_required` is now reported to `onError` before it is thrown, as `continuation_kind_unsupported` is, so a default `governedToolNode` no longer hides it from the builder.
