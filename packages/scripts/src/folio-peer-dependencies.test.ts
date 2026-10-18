import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown) => {
  assert.ok(isRecord(value), "Expected lockfile record");
  return value;
};
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const entry = (value: unknown) => {
  assert.ok(isArray(value), "Expected lockfile package tuple");
  return value;
};

const lock = record(
  Bun.JSONC.parse(
    readFileSync(new URL("../../../bun.lock", import.meta.url), "utf-8"),
  ),
);
const packages = record(lock["packages"]);
const workspaces = record(lock["workspaces"]);
const resolvedPackages = Object.values(packages).map((value) => {
  const resolved = entry(value).at(0);
  assert.ok(typeof resolved === "string", "Expected resolved package identity");
  return resolved;
});

const assertSingleResolution = (
  resolutions: readonly string[],
  peer: string,
) => {
  expect(
    resolutions.filter((resolved) => resolved.startsWith(`${peer}@`)),
    peer,
  ).toHaveLength(1);
};

test("the peer guard rejects missing and duplicate resolutions", () => {
  for (const resolutions of [[], ["yjs@13.6.31", "yjs@13.6.33"]]) {
    expect(() => assertSingleResolution(resolutions, "yjs")).toThrow(
      "Expected length: 1",
    );
  }
});

test("every Folio host owns one shared resolution of every editor and collaboration peer", () => {
  const editorPeers = new Set<string>();
  for (const name of ["@stll/folio-core", "@stll/folio-react"]) {
    const metadata = record(entry(packages[name])[2]);
    const peerDependencies = record(metadata["peerDependencies"]);
    for (const peer of Object.keys(peerDependencies)) {
      if (
        peer.startsWith("prosemirror-") ||
        peer.startsWith("y-") ||
        peer === "yjs"
      ) {
        editorPeers.add(peer);
      }
    }
  }
  expect(editorPeers.size).toBeGreaterThan(0);
  for (const peer of editorPeers) {
    assertSingleResolution(resolvedPackages, peer);
    for (const [workspace, value] of Object.entries(workspaces)) {
      const dependencies = record(value)["dependencies"];
      if (dependencies === undefined) {
        continue;
      }
      const declared = record(dependencies);
      if (declared["@stll/folio-core"] || declared["@stll/folio-react"]) {
        expect(declared[peer], `${workspace}: ${peer}`).toBe("catalog:");
      }
    }
  }
});
