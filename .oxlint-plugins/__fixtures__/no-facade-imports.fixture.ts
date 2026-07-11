// Passive regression fixture for `no-facade-imports/no-facade-imports`.

// oxlint-disable-next-line no-facade-imports/no-facade-imports -- fixture proves the DB facade is rejected
import type { ScopedDb } from "@/api/db";
// oxlint-disable-next-line no-facade-imports/no-facade-imports -- fixture proves renamed facades outside the leaf allowlist are rejected
import type { UnsafeDbFacade } from "@/api/db/convenience";
// Leaf imports remain valid.
import type { SafeDb } from "@/api/db/safe-db";
import { captureRequestError } from "@/api/lib/analytics/capture";
import { toAPIError } from "@/lib/errors/api";
// oxlint-disable-next-line no-facade-imports/no-facade-imports -- fixture proves the analytics facade is rejected
export { captureError } from "@/api/lib/analytics";

const loadErrors = async () =>
  // oxlint-disable-next-line no-facade-imports/no-facade-imports -- fixture proves dynamic facade imports are rejected
  await import("@/lib/errors");

void loadErrors;
void captureRequestError;
void toAPIError;
type _SafeDb = SafeDb;
type _ScopedDb = ScopedDb;
type _UnsafeDbFacade = UnsafeDbFacade;
