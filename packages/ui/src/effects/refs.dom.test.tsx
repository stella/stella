import type { Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { cleanup, render } = await import("@testing-library/react");
const { useComposedRefs } = await import("./refs");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await unregisterDomEnvironment();
});

describe("useComposedRefs", () => {
  test("attaches each member once while the members stay the same", () => {
    const calls: (string | null)[] = [];
    const objectRef: { current: HTMLDivElement | null } = { current: null };
    const callbackRef = (node: HTMLDivElement | null) => {
      calls.push(node?.dataset["name"] ?? null);
    };
    const Box = ({ label }: { label: string }) => {
      const ref = useComposedRefs<HTMLDivElement>(objectRef, callbackRef);
      return (
        <div data-name="box" ref={ref}>
          {label}
        </div>
      );
    };
    const { rerender, unmount } = render(<Box label="a" />);
    rerender(<Box label="b" />);
    rerender(<Box label="c" />);
    expect(calls).toEqual(["box"]);
    expect(objectRef.current?.textContent).toBe("c");
    unmount();
    expect(calls).toEqual(["box", null]);
    expect(objectRef.current).toBeNull();
  });

  test("re-attaches when a member ref changes", () => {
    const seen: string[] = [];
    const named =
      (name: string) =>
      (node: HTMLDivElement | null): (() => void) | undefined => {
        if (node === null) {
          return undefined;
        }
        seen.push(`attach ${name}`);
        return () => {
          seen.push(`detach ${name}`);
        };
      };
    const first = named("first");
    const second = named("second");
    const Box = ({ member }: { member: Ref<HTMLDivElement> }) => {
      const ref = useComposedRefs<HTMLDivElement>(member);
      return <div ref={ref} />;
    };
    const { rerender } = render(<Box member={first} />);
    rerender(<Box member={first} />);
    rerender(<Box member={second} />);
    expect(seen).toEqual(["attach first", "detach first", "attach second"]);
  });
});
