import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports broad route refresh",
    source:
      'import { useRouter } from "@tanstack/react-router";\nconst router = useRouter();\nrouter.invalidate();',
    lines: [3],
    sourcePath: "source.ts",
  },
  {
    title: "reports destructured alias refresh",
    source:
      'import { useRouter as currentRouter } from "@tanstack/react-router";\nconst { invalidate: refresh } = currentRouter();\nrefresh();',
    lines: [3],
    sourcePath: "source.ts",
  },
  {
    title: "allows the lifecycle owner",
    source:
      'import { useRouter } from "@tanstack/react-router";\nconst router = useRouter();\nrouter.invalidate();',
    lines: [],
    sourcePath: "apps/web/src/hooks/use-invalidate-session.ts",
  },
  {
    title: "allows query cache refresh",
    source: 'queryClient.invalidateQueries({ queryKey: ["records"] });',
    lines: [],
    sourcePath: "source.ts",
  },
];

test.each(cases)(
  "no-raw-router-invalidation: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-raw-router-invalidation", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
