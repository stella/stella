import { expect, test } from "bun:test";

import { recordMetadataMount, resolveLocalMetadataPath } from "./references";
import { AdmissionError } from "./yaml";

const resolve = (reference: string, mount: string | null = null) =>
  resolveLocalMetadataPath({
    reference,
    kind: "action",
    relocations: [],
    inheritedMount: mount,
  });

test("nested local actions resolve only within the inherited checkout mount", () => {
  for (const mount of [".tooling", "tools/shared", "vendor"]) {
    for (const target of [".github/actions/build", "actions/nested/check"]) {
      expect(resolve(`./${mount}/${target}`, mount)).toEqual({
        path: target,
        mount,
      });
    }
  }
  for (const reference of [
    "./.other/action",
    "./.tooling2/action",
    "./.tooling/../escape",
    "./.tooling//action",
  ]) {
    expect(() => resolve(reference, ".tooling")).toThrow(AdmissionError);
  }
  expect(resolve("./.github/actions/local")).toEqual({
    path: ".github/actions/local",
    mount: null,
  });
});

test("only same-origin checkout declarations establish a nested mount", () => {
  const options = {
    reference: "./.tooling/.github/actions/build",
    kind: "action",
    inheritedMount: null,
  } as const;
  const relocation = {
    repository: null,
    ref: `\${{ job.workflow_sha }}`,
    path: ".github/actions/build",
  };
  expect(
    resolveLocalMetadataPath({ ...options, relocations: [relocation] }),
  ).toEqual({ path: relocation.path, mount: ".tooling" });
  for (const entry of [
    { ...relocation, repository: "other/repo" },
    { ...relocation, ref: "main" },
    { ...relocation, path: "other/action" },
  ]) {
    expect(() =>
      resolveLocalMetadataPath({ ...options, relocations: [entry] }),
    ).toThrow(AdmissionError);
  }
  expect(() =>
    resolveLocalMetadataPath({
      ...options,
      relocations: [relocation, { ...relocation, path: "actions/build" }],
    }),
  ).toThrow("ambiguous");
});

test("leaf metadata can share mounts but context-dependent edges cannot", () => {
  const mounts = new Map<string, string>();
  const leaf = { dependencies: {}, relocatedActions: {} };
  for (const mount of [null, ".tooling", ".other"]) {
    recordMetadataMount({ mounts, identity: "leaf", mount, document: leaf });
  }
  const document = {
    dependencies: { "./.tooling/action": "action" },
    relocatedActions: {},
  } as const;
  recordMetadataMount({
    mounts,
    identity: "parent",
    mount: ".tooling",
    document,
  });
  expect(() =>
    recordMetadataMount({ mounts, identity: "parent", mount: null, document }),
  ).toThrow("conflicting");
});
