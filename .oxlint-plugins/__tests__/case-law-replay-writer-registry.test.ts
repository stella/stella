import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { REPLAY_WRITER_REGISTRY } from "../case-law-replay-writer-registry.ts";
import { getPropertyName, isAstNode, staticStringValue } from "../utils.ts";
import { auditReplayWriters } from "./case-law-replay-census.ts";
import {
  addedPendingOwners,
  readReplayWriterRegistry,
} from "./read-replay-writer-registry.ts";

const root = path.resolve(import.meta.dir, "../..");
const key = ({ file, line }: { file: string; line: number }) =>
  `${file}:${line}`;

describe.serial("replay writer classifications", () => {
  test("every unguarded replay owner has exactly one current classification", async () => {
    const actual = await auditReplayWriters(root);
    expect(REPLAY_WRITER_REGISTRY.map(key)).toEqual(actual.map(key));
    expect(new Set(REPLAY_WRITER_REGISTRY.map(key)).size).toBe(
      REPLAY_WRITER_REGISTRY.length,
    );
  });
  test("pending owners cannot be added against the merge base", () => {
    const relative = ".oxlint-plugins/case-law-replay-writer-registry.ts";
    const base = treeBaseRevision({ repoRoot: root });
    const tracked = execFileSync(
      "git",
      ["ls-tree", "--name-only", base, relative],
      { cwd: root, encoding: "utf-8" },
    ).trim();
    if (tracked === "") {
      return;
    }
    const previous = execFileSync("git", ["show", `${base}:${relative}`], {
      cwd: root,
      encoding: "utf-8",
    });
    expect(
      addedPendingOwners(
        REPLAY_WRITER_REGISTRY,
        readReplayWriterRegistry(previous),
      ),
    ).toEqual([]);
  });
  test("adding pending debt fails while resolving it can only shrink the registry", () => {
    const original = [...REPLAY_WRITER_REGISTRY];
    const extra = {
      file: "apps/api/src/lib/new-replay-writer.ts",
      line: 1,
      kind: "pending",
    } as const;
    expect(addedPendingOwners([...original, extra], original)).toEqual([extra]);
    expect(addedPendingOwners(original.slice(1), original)).toEqual([]);
    expect(
      readReplayWriterRegistry(
        readFileSync(
          path.join(root, ".oxlint-plugins/case-law-replay-writer-registry.ts"),
          "utf-8",
        ),
      ),
    ).toEqual(original);
  });
  test("each permanent transition names a real executable invariant", () => {
    for (const owner of REPLAY_WRITER_REGISTRY) {
      switch (owner.kind) {
        case "pending":
          break;
        case "transition": {
          const source = readFileSync(
            path.join(root, owner.invariant.file),
            "utf-8",
          );
          const parsed = parseSync(owner.invariant.file, source, {
            range: true,
          });
          let found = false;
          const visit = (node: unknown): void => {
            if (!isAstNode(node)) {
              return;
            }
            if (
              node.type === "CallExpression" &&
              isAstNode(node.callee) &&
              getPropertyName(node.callee) === "test" &&
              Array.isArray(node.arguments) &&
              staticStringValue(node.arguments.at(0)) === owner.invariant.test
            ) {
              found = true;
            }
            for (const [property, value] of Object.entries(node)) {
              if (property === "parent") {
                continue;
              }
              if (Array.isArray(value)) {
                for (const child of value) {
                  visit(child);
                }
              } else {
                visit(value);
              }
            }
          };
          visit(parsed.program);
          expect({
            owner: key(owner),
            invariant: owner.invariant,
            found,
          }).toEqual({
            owner: key(owner),
            invariant: owner.invariant,
            found: true,
          });
          break;
        }
        default:
          owner satisfies never;
      }
    }
  });
});
