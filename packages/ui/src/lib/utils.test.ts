import type * as React from "react";

import { describe, expect, test } from "bun:test";

import { composeRefs } from "./utils";

// React attaches by calling the composed ref and detaches by calling the
// cleanup it returns. The package has no DOM environment, so the tests drive
// that contract directly; a string stands in for the node.
const NODE = "node";

describe("composeRefs", () => {
  test("runs a callback ref's own cleanup rather than detaching it again", () => {
    const calls: (string | null)[] = [];
    let cleaned = 0;
    const ref = (node: string | null) => {
      calls.push(node);
      return () => {
        cleaned += 1;
      };
    };

    const cleanup = composeRefs(ref)(NODE);
    cleanup?.();

    expect(cleaned).toBe(1);
    // Detaching on top of the ref's own cleanup would tear down twice.
    expect(calls).toEqual([NODE]);
  });

  test("detaches a callback ref that returns no cleanup", () => {
    const calls: (string | null)[] = [];

    const cleanup = composeRefs((node: string | null) => {
      calls.push(node);
    })(NODE);
    expect(calls).toEqual([NODE]);

    cleanup?.();
    expect(calls).toEqual([NODE, null]);
  });

  test("assigns and clears object refs", () => {
    const objectRef: React.RefObject<string | null> = { current: null };

    const cleanup = composeRefs(objectRef)(NODE);
    expect(objectRef.current).toBe(NODE);

    cleanup?.();
    expect(objectRef.current).toBeNull();
  });

  test("returns no cleanup when there is nothing to undo", () => {
    const detached: (string | null)[] = [];

    // React still calls refs with `null` on the legacy detach path. Handing it
    // a cleanup there would leave it holding teardown for a dropped node, and
    // the object-ref branch would null out a ref that is already null.
    const detaching = composeRefs((node: string | null) => {
      detached.push(node);
    })(null);

    expect(detaching).toBeUndefined();
    expect(detached).toEqual([null]);

    // Optional forwarded refs arrive absent, which must not synthesize a
    // cleanup for React to call.
    expect(composeRefs(undefined, null)(NODE)).toBeUndefined();
  });

  test("reaches every ref on attach and on detach", () => {
    const objectRef: React.RefObject<string | null> = { current: null };
    const attached: string[] = [];
    const detached: string[] = [];

    const cleanup = composeRefs(
      // Ordered so a ref that supplies its own cleanup sits between two that
      // do not: whichever branch the loop takes, it must keep going.
      (node: string | null) => {
        attached.push(`first:${node}`);
      },
      (node: string | null) => {
        attached.push(`second:${node}`);
        return () => {
          detached.push("second");
        };
      },
      objectRef,
    )(NODE);

    expect(attached).toEqual([`first:${NODE}`, `second:${NODE}`]);
    expect(objectRef.current).toBe(NODE);

    cleanup?.();

    expect(detached).toEqual(["second"]);
    expect(objectRef.current).toBeNull();
  });
});
