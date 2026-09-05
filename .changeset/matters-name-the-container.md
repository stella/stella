---
"@stll/cli": major
---

The client-engagement container is now called a matter everywhere the CLI speaks: `--workspace-id` and the synthesized `--workspace` become `--matter-id`, `stella capability workspaces …` becomes `stella capability matters …`, and the `matter_id` input alias is gone because `matter_id` is now the canonical name. This CLI requires a server on contract revision 2 or newer, and older CLIs cannot talk to one.
