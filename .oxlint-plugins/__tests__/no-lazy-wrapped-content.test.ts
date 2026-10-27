import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const HEADER = 'import { lazy, Suspense } from "react";\n';
const LAZY = 'const LazyChat = lazy(async () => import("./chat"));\n';

const cases = [
  {
    title: "reports a fallback that draws the data its lazy content draws",
    source: `${HEADER}${LAZY}const Page = ({ decision }) => (\n<Suspense\nfallback={<Reader decision={decision} gated />}\n>\n<LazyChat decision={decision} />\n</Suspense>\n);`,
    lines: [5],
  },
  {
    title:
      "reports a lazy component wrapping content its fallback also renders",
    source: `${HEADER}${LAZY}const Page = ({ children }) => (\n<Suspense fallback={<Viewer>{children}</Viewer>}>\n<LazyChat>{children}</LazyChat>\n</Suspense>\n);`,
    lines: [4, 5],
  },
  {
    title: "reports a lazy component wrapping content another branch renders",
    source: `${HEADER}${LAZY}function Page({ children, signedIn }) {\nif (!signedIn) {\nreturn <Viewer>{children}</Viewer>;\n}\nreturn <LazyChat>{children}</LazyChat>;\n}`,
    lines: [7],
  },
  {
    title: "reads React's namespace and a conditional lazy binding",
    source:
      'import * as React from "react";\nconst LazyChat = enabled ? React.lazy(async () => import("./chat")) : Fallback;\nconst Page = ({ decision }) => (\n<React.Suspense\nfallback={<Reader decision={decision?.id} />}\n>\n<LazyChat id={decision?.id} />\n</React.Suspense>\n);',
    lines: [5],
  },
  {
    title: "reports a lazy type declared below the component that renders it",
    source: `${HEADER}const Page = ({ children }) => (\n<Suspense fallback={<Viewer>{children}</Viewer>}>\n<LazyChat>{children}</LazyChat>\n</Suspense>\n);\n${LAZY}`,
    lines: [3, 4],
  },
  {
    title: "allows lazy tools mounted beside the content they add to",
    source: `${HEADER}${LAZY}const Page = ({ decision }) => (\n<>\n<Reader decision={decision} />\n<Suspense fallback={null}>\n<LazyChat decisionId={decision.id} />\n</Suspense>\n</>\n);`,
    lines: [],
  },
  {
    title:
      "reports a fallback that draws a synchronous sibling of the lazy content",
    source: `${HEADER}${LAZY}const Page = ({ decision }) => (\n<Suspense fallback={<Reader decision={decision} />}>\n<Reader decision={decision} />\n<LazyChat />\n</Suspense>\n);`,
    lines: [4],
  },
  {
    title:
      "allows a fallback that draws content whose lazy tools sit in a nested boundary",
    source: `${HEADER}${LAZY}const Page = ({ decision }) => (\n<Suspense fallback={<Reader decision={decision} />}>\n<Reader decision={decision} />\n<Suspense fallback={null}>\n<LazyChat decisionId={decision.id} />\n</Suspense>\n</Suspense>\n);`,
    lines: [],
  },
  {
    title: "allows a placeholder that shares only presentation",
    source: `${HEADER}${LAZY}const Page = ({ decision, onOpen }) => (\n<Suspense fallback={<Skeleton className="h-4" label={t("loading")} onOpen={() => onOpen()} rows={3} value={undefined} />}>\n<LazyChat className="h-4" decision={decision} label={t("loading")} />\n</Suspense>\n);`,
    lines: [],
  },
  {
    title:
      "allows a skeleton that shares only styling and wiring identifiers with the lazy content",
    source: `${HEADER}${LAZY}const Page = ({ className, decision, id, onOpen, style }) => (\n<Suspense fallback={<Skeleton aria-describedby={id} className={className} data-panel={id} key={id} onClick={onOpen} role={id} style={style} tabIndex={id} />}>\n<LazyChat aria-describedby={id} className={className} data-panel={id} decision={decision} key={id} onClick={onOpen} role={id} style={style} tabIndex={id} />\n</Suspense>\n);`,
    lines: [],
  },
  {
    title:
      "reports a fallback that shares a data prop even when it shares styling too",
    source: `${HEADER}${LAZY}const Page = ({ className, decision }) => (\n<Suspense fallback={<Reader className={className} decision={decision} />}>\n<LazyChat className={className} decision={decision} />\n</Suspense>\n);`,
    lines: [4],
  },
  {
    title: "allows lazy content that only it renders",
    source: `${HEADER}${LAZY}const Page = ({ children, fallbackText }) => (\n<Suspense fallback={<Plain>{fallbackText ?? children}</Plain>}>\n<LazyChat>{children}</LazyChat>\n</Suspense>\n);`,
    lines: [],
  },
  {
    title: "ignores a boundary whose content suspends on data",
    source: `${HEADER}const Page = ({ tab }) => (\n<Suspense fallback={<PanelShell tab={tab} />}>\n<Panel tab={tab} />\n</Suspense>\n);`,
    lines: [],
  },
  {
    title: "ignores lazy and Suspense from another module",
    source:
      'import { lazy, Suspense } from "./local";\nconst LazyChat = lazy(async () => import("./chat"));\nconst Page = ({ children }) => (\n<Suspense fallback={<Viewer>{children}</Viewer>}>\n<LazyChat>{children}</LazyChat>\n</Suspense>\n);',
    lines: [],
  },
];

test.each(cases)(
  "no-lazy-wrapped-content: $title",
  async ({ source, lines }) => {
    expect(
      (
        await runSingleRule("no-lazy-wrapped-content", source, {
          sourcePath: "source.tsx",
        })
      ).lines,
    ).toEqual(lines);
  },
);
