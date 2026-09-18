---
"@stll/cli": minor
---

`stella task list` no longer requires `--matter-id`: without it, it lists tasks across every matter you can read, soonest due first, and each task names its matter. `--assignee me` keeps only your own assignments. Adds the `stella capability tasks list` command for the same list over HTTP.
