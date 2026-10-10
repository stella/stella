# Revalidating a persisted membership during an authorized operation

Generated from `scripts/ownership/current-member-permission.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                                       | Owner                                          | Enforcement                                                                                          | Summary                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `current-member-permission` — Revalidating a persisted membership during an authorized operation | `apps/api/src/lib/permission-authorization.ts` | import `hasCurrentMemberPermission` from `@/api/lib/permission-authorization` (plus 2 allowed files) | The request spends its credential at the handler boundary; a locked membership is revalidated by the permission owner. |
