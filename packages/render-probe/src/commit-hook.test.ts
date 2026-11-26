import { expect, test } from "bun:test";

import { installCommitHook } from "./commit-hook";
import type { RendererInternals } from "./commit-hook";

const DEVTOOLS_HOOK = "__REACT_DEVTOOLS_GLOBAL_HOOK__";

const renderer = (
  version: string,
): RendererInternals & { version: string } => ({
  version,
  currentDispatcherRef: { actQueue: null },
});

test("chains onto a hook that renderers already injected into", () => {
  const early = renderer("early");
  const late = renderer("late");
  const forwarded: unknown[] = [];
  const renderers = new Map<number, unknown>([[1, early]]);
  const target = {
    [DEVTOOLS_HOOK]: {
      renderers,
      inject: (internals: unknown) => {
        renderers.set(renderers.size + 1, internals);
        return renderers.size;
      },
      onCommitFiberRoot: (id: number) => {
        forwarded.push(id);
      },
    },
  };

  const hook = installCommitHook(target);
  const seen: RendererInternals[] = [];
  hook.onRenderer((injected) => {
    seen.push(injected);
  });
  const committed: (RendererInternals | undefined)[] = [];
  hook.listen((_root, from) => {
    committed.push(from);
  });

  const devtools = target[DEVTOOLS_HOOK];
  const lateId = devtools.inject(late);
  devtools.onCommitFiberRoot(1);
  devtools.onCommitFiberRoot(lateId);

  expect(seen).toEqual([early, late]);
  expect(committed).toEqual([early, late]);
  expect(forwarded).toEqual([1, lateId]);
  expect(installCommitHook(target)).toBe(hook);
});
