---
"@stll/cli": patch
---

`skills.resources.create` and `skills.resources.update` accept resource files up to 2,000,000 characters, up from 100,000. `skills.resources.upload` rejects a file whose text exceeds that limit instead of truncating it.
