// Passive regression fixture for `no-test-support-import/no-test-support-import`:
// every load of a module under apps/api/src/tests/ is reported once.

// expect-clean: no-test-support-import/no-test-support-import
import { createSafeId } from "@/api/lib/branded-types";
// oxlint-disable-next-line no-test-support-import/no-test-support-import -- named import
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
// oxlint-disable-next-line no-test-support-import/no-test-support-import -- type-only import
import type { TestToolSet } from "@/api/tests/helpers/test-tool-set";

// oxlint-disable-next-line no-test-support-import/no-test-support-import -- dynamic import
const pendingModule = import("@/api/tests/fixture-provenance");

export { asTestRaw, createSafeId, pendingModule };
export type { TestToolSet };
