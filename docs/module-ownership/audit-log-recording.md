# Environment-free audit event recording

Generated from `scripts/ownership/audit-log-recording.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                     | Owner                                | Enforcement                                                                                                        | Summary                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit-log-recording` — Environment-free audit event recording | `apps/api/src/lib/audit-log-core.ts` | import `recordAuditGroups`, `createBackgroundAuditRecorder` from `@/api/lib/audit-log-core` (plus 3 allowed files) | One insertion owner applies audit projection and provenance; the HTTP wrapper binds request metadata while background operations require no API environment. |
