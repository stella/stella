import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-placeholder-stella-mark", source, {
    sourcePath: "source.tsx",
  });

test("rejects the sampled extension popup placeholder", async () => {
  expect(
    await lint(
      'const popup = <div className="mark" aria-hidden="true">S</div>;',
    ),
  ).toEqual([1]);
});

test("rejects each placeholder across brand identity attributes and component names", async () => {
  const openings = [
    'div className="mark"',
    'span className="stella-logo"',
    'div className={"app-icon"}',
    'div aria-label="stella brand"',
    'div aria-label={"stella logo"}',
    'div data-testid="brand-mark"',
    "div data-app-icon",
    "BrandMark",
    "StellaLogo",
    "AppIcon",
  ];
  const sources: string[] = [];
  for (const opening of openings) {
    const closing = opening.replace(/ .*/u, "");
    for (const glyph of ["S", "s", "§", "&sect;", "&#167;"]) {
      sources.push(
        `const mark${sources.length} = <${opening}>${glyph}</${closing}>;`,
      );
    }
  }
  expect(await lint(sources.join("\n"))).toEqual(
    sources.map((_, index) => index + 1),
  );
});

test("rejects static expression children while ignoring comments and whitespace", async () => {
  expect(
    await lint(
      'const mark = <div className="mark"> {/* comment */}{"S"} </div>;',
    ),
  ).toEqual([1]);
  expect(await lint('const mark = <div className="mark">{`s`}</div>;')).toEqual(
    [1],
  );
});

test("allows ordinary text, words, sizes, legal references, and the real symbol", async () => {
  const sources = [
    'const size = <span className="size-label">S</span>;',
    'const word = <div className="brand">stella</div>;',
    "const legal = <span>§ 10</span>;",
    'const splitLegal = <div className="mark">§ <a>10</a></div>;',
    'const real = <div className="mark"><StellaMark /></div>;',
    "const unrelated = <Landmark>S</Landmark>;",
    'const dynamic = <div className="mark">{name}</div>;',
    'const mixed = <div className="mark">S{count}</div>;',
  ];
  expect(await lint(sources.join("\n"))).toEqual([]);
});
