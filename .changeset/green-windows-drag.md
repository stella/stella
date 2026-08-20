---
"@stll/ui": minor
---

Export the kanban card drag lifecycle and horizontal board auto-scroll from
`@stll/ui/kanban`. Card payloads and drop persistence stay with the application;
the package owns the shared drag preview and overflow-boundary behaviour. The
Atlaskit v3 is a peer contract, so drag sources, targets, and monitors share one
adapter instance.
