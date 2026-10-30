# OAuth user-grant admission

Generated from `scripts/ownership/oauth-grant-admission.ts`. See [Module ownership](../module-ownership.md).

| Capability                                           | Owner                     | Enforcement                                                                 | Summary                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth-grant-admission` — OAuth user-grant admission | `apps/api/src/db/root.ts` | import `readOAuthGrantAdmission` from `@/api/db/root` (plus 1 allowed file) | The connection owner reads one user, organization and client grant's revocation and registration. The admission owner verifies resource tokens and constructs opaque admitted credentials; consumers receive no owner database handle. |
