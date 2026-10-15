import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "object-storage",
  capability: "Object storage reads, writes, and presigned uploads",
  owner: ["apps/api/src/lib/s3.ts", "apps/api/src/lib/s3-presign.ts"],
  summary:
    "`s3.ts` owns the cancellable transport, credential resolution, and " +
    "response validation; `s3-presign.ts` owns the presigned PUT flow, which " +
    "signs size and checksum headers Bun's client cannot. The " +
    "`no-native-s3-object-read` and `no-native-s3-object-write` rules already " +
    "enforce this boundary.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
