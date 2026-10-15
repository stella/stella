# Reading tenant-scoped stored file bytes

Generated from `scripts/ownership/stored-tenant-file-read.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                          | Owner                                       | Enforcement                                                                         | Summary                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stored-tenant-file-read` — Reading tenant-scoped stored file bytes | `apps/api/src/lib/file-scan/stored-file.ts` | import `readTenantS3ArrayBuffer` from `@/api/lib/s3-presign` (plus 4 allowed files) | `readStoredFile` owns stored file reads for request delivery. Named processing, maintenance, and transport-test consumers use the raw readers for their specific operations. |
