import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects route suspense factories when a loader is absent", async () => {
  expect(
    await lintSingleRule(
      "require-loader-prefetch",
      'createFileRoute("/items")({ component: Page });\nfunction Page() { useSuspenseQuery(itemOptions(id));\n useSuspenseQuery(settingsOptions); }',
    ),
  ).toEqual([2, 3]);
});

test("rejects factories omitted by an existing loader", async () => {
  expect(
    await lintSingleRule(
      "require-loader-prefetch",
      'createFileRoute("/items")({ loader: () => prefetch(otherOptions()), component: Page });\nfunction Page() { useSuspenseQuery(itemOptions(id)); }',
    ),
  ).toEqual([2]);
});

test("accepts references to all suspense factories in the loader", async () => {
  expect(
    await lintSingleRule(
      "require-loader-prefetch",
      'createFileRoute("/items")({ loader: () => { ensureRouteQueryData(itemOptions(id)); prefetchRouteQuery(settingsOptions); }, component: Page });\nfunction Page() { useSuspenseQuery(itemOptions(id)); useSuspenseQuery(settingsOptions); }',
    ),
  ).toEqual([]);
});

test("leaves nonroute components and opaque factory members alone", async () => {
  expect(
    await lintSingleRule(
      "require-loader-prefetch",
      "function Page() { useSuspenseQuery(itemOptions(id)); }",
    ),
  ).toEqual([]);
});

test("does not guess an opaque factory member in a route", async () => {
  expect(
    await lintSingleRule(
      "require-loader-prefetch",
      'createFileRoute("/items")({ component: Page });\nfunction Page() { useSuspenseQuery(options.items(id)); }',
    ),
  ).toEqual([]);
});

// The route and its child must share a real isolated alias root for the one-hop read.
const lintColocatedRoute = async (source: string) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-prefetch-child-"),
  );
  try {
    await Bun.write(
      path.join(directory, "apps/web/src/routes/-components/card.tsx"),
      "export const Card = () => useSuspenseQuery(childOptions(id));",
    );
    const sourcePath = path.join(
      "..",
      path.basename(directory),
      "apps/web/src/routes/index.tsx",
    );
    return await lintSingleRule("require-loader-prefetch", source, {
      sourcePath,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

test("requires prefetch for factories in a colocated child import", async () => {
  expect(
    await lintColocatedRoute(
      'import { Card } from "@/routes/-components/card";\ncreateFileRoute("/")({ component: Card });',
    ),
  ).toEqual([1]);
});

test("accepts the colocated child when its factory is referenced by the loader", async () => {
  expect(
    await lintColocatedRoute(
      'import { Card } from "@/routes/-components/card";\ncreateFileRoute("/")({ loader: () => prefetchRouteQuery(childOptions(id)), component: Card });',
    ),
  ).toEqual([]);
});

test("does not follow nondash imports or unreadable colocated files", async () => {
  expect(
    await lintColocatedRoute(
      'import { Card } from "@/routes/components/card";\nimport { Missing } from "@/routes/-components/missing";\ncreateFileRoute("/")({ component: Card });',
    ),
  ).toEqual([]);
});
