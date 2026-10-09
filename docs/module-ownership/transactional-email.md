# Transactional email templates and delivery

Generated from `scripts/ownership/transactional-email.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                         | Owner                                                      | Enforcement | Summary                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transactional-email` — Transactional email templates and delivery | `apps/api/src/lib/email/smtp.ts`, `packages/transactional` | none        | `smtp.ts` owns the transport, including the TLS requirement and the credential-pair validation. `@stll/transactional` owns the templates and their translations, so recipient-facing copy stays localized in one place. |
