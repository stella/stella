---
"@stll/cli": patch
---

`matters.get` reads one matter, archived ones included, and `matters.contacts.list` lists a matter's parties in their roles. `matter add-member` and `matter remove-member` (and `matters.members.add`/`.remove`) now need the matters write consent instead of the admin one; who may run them is unchanged.
