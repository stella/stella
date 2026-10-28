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

test("a repeated metadata node cannot silently inherit another caller's mount", () => {
  for (const [first, second] of [
    [null, ".tooling"],
    [".tooling", null],
    [".tooling", ".other"],
  ]) {
    const mounts = new Map<string, string | null>();
    const mount = first ?? null;
    recordMetadataMount({ mounts, identity: "action", mount });
    recordMetadataMount({ mounts, identity: "action", mount });
    expect(() =>
      recordMetadataMount({
        mounts,
        identity: "action",
        mount: second ?? null,
      }),
    ).toThrow("conflicting");
  }
});
