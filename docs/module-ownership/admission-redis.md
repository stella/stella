# Non-evicting admission coordination

Generated from `scripts/ownership/admission-redis.ts`. See [Module ownership](../module-ownership.md).

| Capability                                              | Owner                                                                           | Enforcement                                               | Summary                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admission-redis` — Non-evicting admission coordination | `apps/api/src/lib/admission-redis.ts`, `apps/api/src/lib/non-evicting-redis.ts` | import `@/api/lib/admission-redis` (plus 3 allowed files) | Admission, reservations, and fences use a checked command facade. A reported evicting policy refuses work; uninspectable policies warn. These callers cannot import the unchecked connection factory. |
