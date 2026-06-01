import { describe, expect, it, mock } from "bun:test";

// Bun's default test runtime has no DOM globals. The helper does a
// runtime `instanceof Node` check, so we install a minimal Node stand-in
// before importing it. Real consumers run in the browser where Node is
// the genuine DOM interface.
class FakeNode {
  nodeType = 1;
}
(globalThis as unknown as { Node: typeof FakeNode }).Node = FakeNode;

const { containedHandler } =
  await import("@stll/ui/hooks/use-contained-handler");

type SyntheticLike = { target: EventTarget | null };

const makeRef = <T>(node: T | null) => ({ current: node });

const makeContainer = (containsImpl: (other: object) => boolean) =>
  ({ contains: containsImpl }) as unknown as HTMLElement;

const node = (): object => new FakeNode();

describe("containedHandler", () => {
  it("invokes the handler when the target sits inside the ref subtree", () => {
    const target = node();
    const container = makeContainer((other) => other === target);
    const handler = mock<(e: SyntheticLike) => void>(() => {});

    containedHandler(
      makeRef(container),
      handler,
    )({
      target: target as unknown as EventTarget,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("blocks the handler when the target sits outside the ref subtree", () => {
    const container = makeContainer(() => false);
    const handler = mock<(e: SyntheticLike) => void>(() => {});

    containedHandler(
      makeRef(container),
      handler,
    )({
      target: node() as unknown as EventTarget,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("falls through when the ref has not attached yet", () => {
    const handler = mock<(e: SyntheticLike) => void>(() => {});

    containedHandler(
      makeRef<HTMLElement>(null),
      handler,
    )({
      target: node() as unknown as EventTarget,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the handler is undefined", () => {
    // Callers write `inline ? undefined : containedHandler(ref, h)`;
    // the helper must accept undefined without crashing.
    const container = makeContainer(() => true);

    expect(() =>
      containedHandler(
        makeRef(container),
        undefined,
      )({ target: node() as unknown as EventTarget }),
    ).not.toThrow();
  });

  it("falls through when the target is null", () => {
    // EventTarget can be null (e.g. document-level events). The
    // containment branch requires a Node, so the helper passes
    // through to the inner handler — matching plain React behavior.
    const container = makeContainer(() => false);
    const handler = mock<(e: SyntheticLike) => void>(() => {});

    containedHandler(makeRef(container), handler)({ target: null });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("falls through when target is not a Node (e.g. a Window)", () => {
    // window focus/blur events surface `target = window`, which is an
    // EventTarget but not a Node. The helper must not block them.
    const container = makeContainer(() => false);
    const handler = mock<(e: SyntheticLike) => void>(() => {});

    containedHandler(
      makeRef(container),
      handler,
    )({
      target: { plain: true } as unknown as EventTarget,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
