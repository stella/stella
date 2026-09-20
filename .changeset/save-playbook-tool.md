---
"@stll/cli": minor
---

The new `playbook save` creates a review playbook, or adds, changes, and removes positions in one: `positions` lists only what a call adds or changes (an entry with `source_id` replaces that stored position, one without is added), `remove_source_ids` deletes, and an update passes the playbook's `updatedAt` as `expected_updated_at`. `playbooks create` and `playbooks update` are now reached through it.
