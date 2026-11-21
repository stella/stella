import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports physical Tailwind directions",
    source: 'const view = <div className="ml-2 text-right" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows logical directions",
    source: 'const view = <div className="ms-2 text-end" />;',
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title: "reports template class directions",
    source: `const view = <div className={\`pr-4 \${extra}\`} />;`,
    lines: [1],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "no-physical-properties: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (await runSingleRule("no-physical-properties", source, { sourcePath }))
        .lines,
    ).toEqual(lines);
  },
);

test("fixes only proven Tailwind class values", async () => {
  expect(
    await runSingleRule(
      "no-physical-properties",
      'const view = <div className="ml-2 text-right" />;',
      { sourcePath: "source.tsx", fix: true },
    ),
  ).toEqual({
    lines: [],
    source: 'const view = <div className="ms-2 text-end" />;',
  });
  const prose = 'const help = "right-click to continue";';
  expect(
    await runSingleRule("no-physical-properties", prose, { fix: true }),
  ).toEqual({ lines: [1], source: prose });
});
