---
"@stll/auth-model": patch
---

The opaque organization slug's random source takes an ArrayBuffer-backed byte view, so the module type-checks under both the Node and DOM declarations of `crypto.getRandomValues`.
