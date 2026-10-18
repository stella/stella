// Passive regression fixture for
// `no-shared-checkout-mutation/no-shared-checkout-mutation`.

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = new URL("..", import.meta.url);
const checkout = path.join(import.meta.dir, "../..");

// MUST flag: removes a file named from the repository root.
// oxlint-disable-next-line no-shared-checkout-mutation/no-shared-checkout-mutation -- fixture: root-derived removal
await rm(new URL("fixture.json", root));

// MUST flag: overwrites a file in the shared checkout.
// oxlint-disable-next-line no-shared-checkout-mutation/no-shared-checkout-mutation -- fixture: root-derived write
await writeFile(path.join(checkout, "baseline.json"), "changed");

// Clean: writes under a temporary directory.
const scratch = await mkdtemp(path.join(tmpdir(), "rule-fixture-"));
// expect-clean: no-shared-checkout-mutation/no-shared-checkout-mutation
await writeFile(path.join(scratch, "fixture"), "changed");

// Clean: copies a checkout input into a temporary destination.
// expect-clean: no-shared-checkout-mutation/no-shared-checkout-mutation
await copyFile(path.join(checkout, "package.json"), path.join(scratch, "copy"));
