---
'@noblecloak/langgraph': minor
---

Breaking: an `allow` decision that carries an approval handle is refused `not_locally_executable` for a tool not declared gateway-executed. Such a decision is the gateway admitting the call by an approval it holds, which nothing in the adapter consumes; running a local function on it let any process that re-decided the call run the action again until the approval expired. A declared tool (`gatewayTools` / `executedBy: 'gateway'`) runs as before, and a worker graph must now carry the same declaration as the agent's; the approval this call's own decision opened is withdrawn, as for a `step_up` the deployment executes.

`gatewayCallContext` reads only a run the adapter handed off. The adapter removes `noblecloak_external_run_id` from every `configurable` it invokes a tool with (both the tool-node and the middleware paths) and sets it only for a declared gateway tool, from the run it decided under, as an object it alone can mint; a run id placed in `configurable` by whoever invoked the graph is never named to the gateway. A function reading the key directly instead of calling `gatewayCallContext` now sees that object, not a string.
