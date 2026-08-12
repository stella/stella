---
"@stll/cli": patch
---

Carry the playbook concurrency tokens in the generated catalog and route map. `playbooks.approve` now requires `--expected-updated-at` (the `updatedAt` read with the definition) and refuses to snapshot a definition that changed since; `playbooks.update` accepts the same flag optionally and refuses a stale overwrite when it is given. Both commands return the definition's new `updatedAt` for the next call.
