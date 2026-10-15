import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { buildCapabilityHandlerIndex } from "./capability-handler-index";

test("dispatch follows default, named and re-exported handler source exports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handler-index-"));
  const directory = path.join(root, "apps/api/src/handlers/workspaces");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "list.ts"),
      "export default { handler() {} }; export const named = { handler() {} }; export type TypeOnly = {};\n",
    );
    await writeFile(
      path.join(directory, "get.ts"),
      "const endpoint = {}; export { endpoint as default, endpoint as alias };\n",
    );
    const handlers = await buildCapabilityHandlerIndex(root, [
      "matters.list",
      "matters.list.named",
      "matters.get",
      "matters.get.alias",
    ]);
    expect(
      [...handlers].toSorted(([left], [right]) =>
        // oxlint-disable-next-line require-cached-collator/require-cached-collator -- capability ids are non-linguistic keys
        left.localeCompare(right),
      ),
    ).toEqual([
      [
        "matters.get",
        { importPath: "@/api/handlers/workspaces/get", exportName: undefined },
      ],
      [
        "matters.get.alias",
        { importPath: "@/api/handlers/workspaces/get", exportName: "alias" },
      ],
      [
        "matters.list",
        { importPath: "@/api/handlers/workspaces/list", exportName: undefined },
      ],
      [
        "matters.list.named",
        { importPath: "@/api/handlers/workspaces/list", exportName: "named" },
      ],
    ]);
    expect(
      await rejectionOf(
        buildCapabilityHandlerIndex(root, ["matters.list.TypeOnly"]),
      ),
    ).toMatchObject({
      message: expect.stringContaining("has no handler source export"),
    });
    await rm(path.join(directory, "list.ts"));
    expect(
      await rejectionOf(buildCapabilityHandlerIndex(root, ["matters.list"])),
    ).toMatchObject({
      message: expect.stringContaining("has no handler source export"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous source identities fail instead of selecting a handler silently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "handler-index-collision-"));
  try {
    for (const directory of ["workspaces", "matters"]) {
      const source = path.join(root, "apps/api/src/handlers", directory);
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "list.ts"), "export default {};\n");
    }
    expect(
      await rejectionOf(buildCapabilityHandlerIndex(root, ["matters.list"])),
    ).toMatchObject({
      message: "Capability matters.list has multiple handler sources",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
