---
"@stll/cli": minor
---

Smooth out the first-session papercuts: a registry cache the current schema cannot read is rebuilt instead of skipped forever; unknown commands and flags exit 2 and auth failures exit 3 per the documented contract; a default login requests the working scope set; tables fit the terminal, drop empty columns, and flatten nested objects; tool errors name the flag instead of the wire field; `--input` accepts camelCase keys; help briefs use the tool's description, groups list their commands, and a Required line states each command's inputs; workspace-scoped capabilities all take `--workspace-id`; commands a deployment has gated off are marked in help and `tools list`; `upload` prints the finalized document like other saves; `auth whoami` says how long the session has left; `task delete` removes a task (new `delete_task` tool).
