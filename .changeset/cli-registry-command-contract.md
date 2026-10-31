---
"@stll/cli": patch
---

Accept vendor schema annotations, cache trusted registry projections between commands, serialize token refreshes, and distinguish missing scopes, disabled features, incompatible protocols and commands unknown to the server. Add template list paging and validate every generated list and curated command binding against the server contract. Resolve effective scope grants once for command discovery and execution.

Keep template pagination stable after boundary deletion, allow unrelated credential refreshes to overlap, and report registry persistence failures consistently.
