import path from "node:path";

import {
  inspectBundleOwnership,
  inspectEmbeddedBundleMap,
} from "./lib/bundle-ownership";

const root = path.resolve(import.meta.dirname, "../../..");
const findings = await inspectBundleOwnership(root);
findings.push(
  ...inspectEmbeddedBundleMap(
    await Bun.file(
      path.join(root, "packages/mcp-apps/src/embedded-bundles.ts"),
    ).text(),
  ),
);
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}
