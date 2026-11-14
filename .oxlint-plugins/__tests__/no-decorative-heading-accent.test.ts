import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("heading accents preserve layout and numeric meaning", async () => {
  const cases = [
    ['<h2><span className="italic">Title</span></h2>', true],
    ['<h2><em style={{ color: "red" }}>Title</em></h2>', true],
    [
      '<CardHeading><span><strong className="font-bold">Title</strong></span></CardHeading>',
      true,
    ],
    ['<h2><span className="truncate min-w-0">Title</span></h2>', false],
    ['<h2><span className="md:truncate">Title</span></h2>', false],
    [
      '<h2><span className="text-muted-foreground font-normal tabular-nums">42</span></h2>',
      false,
    ],
    ['<h2><span className="tabular-nums font-bold">42</span></h2>', true],
    ['<h2><span className="truncate italic">Title</span></h2>', true],
    [
      '<h2><a href="/details"><span className="underline">Details</span></a></h2>',
      false,
    ],
    ['<h2><i className="italic" lang="la">bona fide</i></h2>', false],
    ['<h2><mark className="bg-yellow" aria-label="new">N</mark></h2>', false],
    ["<h2><strong>Title</strong></h2>", false],
    ['<p><span className="italic">Body</span></p>', false],
    [
      '<h2>One <span className="tabular-nums text-muted-foreground">word</span></h2>',
      true,
    ],
    [
      '<h2>Items <span className="tabular-nums">{format.number(count)}+</span></h2>',
      false,
    ],
    [
      '<h2>Items <span className="tabular-nums">{format.number(count)} word</span></h2>',
      true,
    ],
    ['<h2>Items <span className="tabular-nums">٤٢</span></h2>', false],
  ] as const;
  await Promise.all(
    [true, false].map(async (reported) => {
      const cohort = cases.filter(([, expected]) => expected === reported);
      const source = cohort
        .map(
          ([element], index) =>
            `export const Case${index} = () => (${element});`,
        )
        .join("\n");
      expect(
        await lintSingleRule("no-decorative-heading-accent", source, {
          sourcePath: "source.tsx",
        }),
      ).toEqual(
        cohort.flatMap(([, expected], index) => (expected ? [index + 1] : [])),
      );
    }),
  );
});
