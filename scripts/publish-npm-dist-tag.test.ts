import { describe, expect, test } from "bun:test";

import cli from "../packages/cli/package.json" with { type: "json" };
import fetchPackage from "../packages/fetch/package.json" with { type: "json" };
import scanEngine from "../packages/scan-engine/package.json" with { type: "json" };
import { publicationOrder } from "./publish-packages";

describe("npm publication order", () => {
  test("places every workspace dependency before its dependent", () => {
    const cliDependingOnFirstRelease = {
      ...cli,
      dependencies: {
        ...cli.dependencies,
        "@stll/scan-engine": "workspace:^",
      },
    };
    const order = publicationOrder(
      [cliDependingOnFirstRelease, fetchPackage, scanEngine],
      ["cli"],
    );

    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("scan-engine"));
    expect(order.at(-1)).toBe("cli");
  });

  test("gives the CLI smoke install dependency tarballs from the same run", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("dependency_tarballs");
    expect(
      workflow.match(
        /npm install --ignore-scripts "\$\{dependency_tarballs\[@\]\}" "\$tarball"/gu,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain(
      'bun scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE"',
    );
  });
});
