---
'@noblecloak/langgraph': patch
---

The adapter's dependency on `@noblecloak/client` is the range `>=0.13.1 <0.15.0` instead of the exact version `0.13.1`, so an application that installs its own `@noblecloak/client` 0.13.1 through 0.14.x gets one copy instead of a second, nested 0.13.1. Built and tested against `@noblecloak/client` 0.14.1 and `@noblecloak/spec` 0.12.3 (contract rev 18, unchanged). No API or behaviour change in the adapter.
