# Declaring stable monitoring identity literals

Generated from `scripts/ownership/synthetic-principal-literals.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                     | Owner                                   | Enforcement                                                    | Summary                                                                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `synthetic-principal-literals` — Declaring stable monitoring identity literals | `apps/api/src/lib/synthetic-principal/` | literal pattern `synthetic-prod-[a-z]+` (plus 2 allowed files) | Identity comparisons use the owning predicate; schema migrations enforce the same persisted identities. |
