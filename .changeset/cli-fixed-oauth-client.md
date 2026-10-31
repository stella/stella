---
"@stll/cli": patch
---

`stella auth login` signs in as the client the server publishes for the CLI and no longer registers a client of its own. A server whose authorization server cannot identify the CLI that way (no https issuer, or no client metadata document support) is refused; use an API key there.
