import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires sanitization at dynamic anchor boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-unsanitized-href",
      "const a = <a href={value}>Open</a>;\nconst b = <a href={record.url}>Open</a>;",
      {
        plugin: "security-guards",
        sourcePath: "apps/web/src/components/example.tsx",
        cwd: "scratch",
      },
    ),
  ).toEqual([1, 2]);
});

test("accepts canonical sanitizer aliases and reader policy gates", async () => {
  expect(
    await lintSingleRule(
      "no-unsanitized-href",
      'import { sanitizeHref as clean } from "@/lib/sanitize-href";\nimport { readerHref } from "@/components/legal-reader/source-link-policy";\nconst a = <a href={clean(value)}>Open</a>;\nconst b = <a href={readerHref(value, policy)}>Open</a>;',
      {
        plugin: "security-guards",
        sourcePath: "apps/web/src/components/example.tsx",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("does not trust a same named foreign sanitizer", async () => {
  expect(
    await lintSingleRule(
      "no-unsanitized-href",
      'import { sanitizeHref } from "./other";\nconst a = <a href={sanitizeHref(value)}>Open</a>;',
      {
        plugin: "security-guards",
        sourcePath: "apps/web/src/components/example.tsx",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});

test("allows safe static navigation and absent destinations", async () => {
  expect(
    await lintSingleRule(
      "no-unsanitized-href",
      'const a = <a href="https://example.com">Open</a>;\nconst b = <a href="/example">Open</a>;\nconst c = <a href="#section">Open</a>;\nconst d = <a href={undefined}>Open</a>;\nconst e = <a href={null}>Open</a>;',
      {
        plugin: "security-guards",
        sourcePath: "apps/web/src/components/example.tsx",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("ignores href props on non anchor components", async () => {
  expect(
    await lintSingleRule(
      "no-unsanitized-href",
      "const a = <Link href={value}>Open</Link>;",
      {
        plugin: "security-guards",
        sourcePath: "apps/web/src/components/example.tsx",
        cwd: "scratch",
      },
    ),
  ).toEqual([]);
});

test("rejects a lexically shadowed sanitizer import", async () => {
  expect(
    await lintSingleRule(
      "no-unsanitized-href",
      'import { sanitizeHref } from "@/lib/sanitize-href";\nfunction local(sanitizeHref) { return <a href={sanitizeHref(value)}>Open</a>; }',
      {
        plugin: "security-guards",
        sourcePath: "apps/web/src/components/example.tsx",
        cwd: "scratch",
      },
    ),
  ).toEqual([2]);
});
