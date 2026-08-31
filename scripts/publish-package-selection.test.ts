import { describe, expect, test } from "bun:test";

import { selectPublishPackages } from "./publish-package-selection";

describe("publish package selection", () => {
  test("publish workflow delegates push selection to the tested resolver", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      'mapfile -t pkgs < <(bun scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE")',
    );
    expect(workflow).not.toContain(
      "pkgs=(auth-model ai-catalog anonymize-chat chat",
    );
    expect(workflow).toContain(
      `if [[ "${String.fromCodePoint(36)}{#pkgs[@]}" -eq 0 ]]; then`,
    );
  });

  test("pushes only packages with a version changelog", () => {
    expect(
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: [
          "packages/ui/CHANGELOG.md",
          "packages/workspace-ui/CHANGELOG.md",
        ],
      }),
    ).toEqual(["ui", "workspace-ui"]);
  });

  test("does not republish a historically tagged but unpublished package", () => {
    expect(
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: ["packages/ui/CHANGELOG.md"],
      }),
    ).not.toContain("chat");
  });

  test("passes only an explicitly requested prior artifact run to the verified recovery path", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("artifact_run_id:");
    expect(workflow).toContain(
      `artifact-run-id: ${String.fromCodePoint(36)}{{ inputs.artifact_run_id || '' }}`,
    );
    expect(workflow).toContain(
      "The reusable workflow verifies that a resumed artifact comes from this",
    );
  });

  test("selects an explicit historical recovery package without requiring new tooling in old source", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      'elif [[ "$EVENT_NAME" == "workflow_dispatch" && "$MANUAL_PACKAGE" != "all" ]]; then',
    );
    expect(workflow).toContain('pkgs=("$MANUAL_PACKAGE")');
    expect(workflow).toContain(
      "Recovery is\n          # always one named non-CLI package",
    );
  });

  test("keeps workflow-run CLI releases explicit", () => {
    expect(
      selectPublishPackages({
        eventName: "workflow_run",
        manualPackage: "all",
        changedPaths: [],
      }),
    ).toEqual(["cli"]);
  });

  test("rejects a push with no changed library changelog", () => {
    expect(() =>
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: ["packages/chat/src/index.ts"],
      }),
    ).toThrow("no changed library changelog");
  });
});
