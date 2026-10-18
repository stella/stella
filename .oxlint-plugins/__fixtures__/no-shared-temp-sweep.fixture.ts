// Passive regression fixture for no-shared-temp-sweep/no-shared-temp-sweep.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// oxlint-disable-next-line no-shared-temp-sweep/no-shared-temp-sweep -- fixture proves shared-root enumeration cannot establish ownership
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith("ratchet-derived-totals-")) {
    rmSync(path.join(tmpdir(), name), { recursive: true, force: true });
  }
}

// expect-clean: no-shared-temp-sweep/no-shared-temp-sweep
const owned = mkdtempSync(path.join(tmpdir(), "owned-fixture-"));
rmSync(owned, { recursive: true, force: true });
