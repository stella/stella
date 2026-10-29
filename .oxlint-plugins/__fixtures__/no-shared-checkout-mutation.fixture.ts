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

// Clean: a unique temporary directory inside the checkout.
const local = await mkdtemp(path.join(checkout, ".cache", "rule-fixture-"));
// expect-clean: no-shared-checkout-mutation/no-shared-checkout-mutation
await writeFile(path.join(local, "fixture"), "changed");

// MUST flag: `..` climbs out of the temporary directory into the checkout.
// oxlint-disable-next-line no-shared-checkout-mutation/no-shared-checkout-mutation -- fixture: joined traversal
await writeFile(path.join(local, "..", "baseline.json"), "changed");

// MUST flag: the same traversal through path.resolve.
// oxlint-disable-next-line no-shared-checkout-mutation/no-shared-checkout-mutation -- fixture: resolved traversal
await writeFile(path.resolve(local, "../baseline.json"), "changed");

// MUST flag: traversal from a directory built under the temporary one.
const nested = path.join(local, "nested");
// oxlint-disable-next-line no-shared-checkout-mutation/no-shared-checkout-mutation -- fixture: nested traversal
await writeFile(path.join(nested, "../..", "baseline.json"), "changed");

// MUST flag: traversal in a template literal.
// oxlint-disable-next-line no-shared-checkout-mutation/no-shared-checkout-mutation -- fixture: template traversal
await writeFile(`${local}/../baseline.json`, "changed");

// Clean: `..` out of a system temporary directory stays outside the checkout.
// expect-clean: no-shared-checkout-mutation/no-shared-checkout-mutation
await writeFile(path.join(scratch, "..", "sibling"), "changed");
