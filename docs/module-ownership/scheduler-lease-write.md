# Claiming and releasing a scheduler job lease

Generated from `scripts/ownership/scheduler-lease-write.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                             | Owner                                  | Enforcement                                                                                                                | Summary                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduler-lease-write` — Claiming and releasing a scheduler job lease | `apps/api/src/lib/scheduler/runner.ts` | write `schedulerJobs.lockedBy`, `schedulerJobs.lockedAt`, `schedulerJobs.lockedUntil` in an insert, update or conflict set | A job lease is its token, claim time and expiry. The runner claims, renews and releases it as one, and its token guards every write a lease holder makes. |
