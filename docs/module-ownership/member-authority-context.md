# Building the authority a request context carries

Generated from `scripts/ownership/member-authority-context.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                    | Owner                                          | Enforcement                                                                                                         | Summary                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `member-authority-context` — Building the authority a request context carries | `apps/api/src/lib/permission-authorization.ts` | import `sessionMemberRole`, `authorizedMemberRole` from `@/api/lib/permission-authorization` (plus 8 allowed files) | Context builders construct opaque member authority once; handlers spend it through the permission owner. |
