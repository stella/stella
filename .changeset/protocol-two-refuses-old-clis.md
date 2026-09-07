---
"@stll/cli": minor
---

The server advertises API protocol 2 for the matter vocabulary, and this CLI
speaks only protocol 2. A CLI built for protocol 1 now fails
`compatibility check` against such a server with an upgrade message, instead
of failing on its first renamed input.
