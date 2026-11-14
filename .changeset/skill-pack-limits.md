---
"@stll/cli": patch
---

`skills.upload` and `uploads.create` (purpose `agent_skill`) accept skill packs up to 50 MB, up from 2 MB. A pack may hold up to 1,000 files, 50 MB uncompressed and 500 resources. `skills.upload` now also answers the installed skill's `name`.
