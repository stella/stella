# Constructing BullMQ workers with a shared failure record policy

Generated from `scripts/ownership/bullmq-worker.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                        | Owner                              | Enforcement                   | Summary                                                                                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bullmq-worker` — Constructing BullMQ workers with a shared failure record policy | `apps/api/src/lib/bullmq-queue.ts` | import `Worker` from `bullmq` | BullMqWorker owns persisted job failure records while retaining original errors in worker events. All queue workers use this constructor. |
