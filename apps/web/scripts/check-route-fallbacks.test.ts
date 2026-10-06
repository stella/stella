import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkRouteFallbacks,
  FIRST_FRAME_OWNERS,
} from "./check-route-fallbacks";

const withSources = async (
  files: Record<string, string>,
  run: (directory: string) => void,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "route-fallbacks-"));
  try {
    const routes = Object.keys(files).filter(
      (file) =>
        file.startsWith("routes/") && !file.split("/").at(-1)?.startsWith("-"),
    );
    const sources = {
      "routeTree.gen.ts": routes
        .map(
          (file, index) =>
            `import { Route as Route${index} } from './${file.replace(/\.tsx?$/u, "")}'`,
        )
        .join("\n"),
      "router.tsx":
        "const router = createRouter({defaultPendingComponent: () => <div/>})",
      ...files,
    };
    for (const [file, source] of Object.entries(sources)) {
      await mkdir(path.dirname(path.join(directory, file)), {
        recursive: true,
      });
      await writeFile(path.join(directory, file), source);
    }
    run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("every registered route and route Suspense fallback keeps chrome with its first frame owner", () => {
  const result = checkRouteFallbacks(
    fileURLToPath(new URL("../src/", import.meta.url)),
  );
  expect(result.registeredRoutes).toBeGreaterThan(100);
  expect(
    result.census.filter(({ kind }) => kind === "defaultPendingComponent"),
  ).toHaveLength(1);
  expect(
    result.census.filter(({ kind }) => kind === "Suspense").length,
  ).toBeGreaterThan(40);
  expect(result.violations).toEqual([]);
});

test.each([
  [
    "direct",
    "import { Sidebar } from '@/components/sidebar'; const Pending = () => <Sidebar/>;",
  ],
  [
    "local helper",
    "import { Sidebar as Chrome } from '@/components/sidebar'; const Inner = () => <Chrome/>; const Pending = () => <Inner/>;",
  ],
  ["re-export", "import { Frame as Pending } from '@/barrel';"],
  [
    "namespace",
    "import * as Frame from '@/barrel'; const Pending = () => <Frame.Frame/>;",
  ],
  [
    "lazy",
    "import {lazy} from 'react'; const Pending = lazy(() => import('@/frame'));",
  ],
  [
    "lazy named",
    "import {lazy} from 'react'; const Pending = lazy(() => import('@/named-frame').then(module => ({default: module.Frame})));",
  ],
  [
    "workspace frame",
    "import {WorkspaceFrame as Pending} from '@stll/workspace-ui/workspace-frame';",
  ],
  [
    "render local",
    "import {Sidebar} from '@/components/sidebar'; function Pending(){const body=<Sidebar/>;return body;}",
  ],
])(
  "rejects %s shell ownership through fallback component symbols",
  async (_name, source) => {
    await withSources(
      {
        "routes/index.tsx": `${source} export const Route = createFileRoute('/')({pendingComponent: Pending});`,
        "barrel.ts": "export {default as Frame} from './frame';",
        "frame.tsx":
          "import {StellaWordmark as Brand} from '@stll/ui/stella-wordmark'; export default function Frame(){return <Brand/>}",
        "named-frame.tsx":
          "import {WorkspaceFrame} from '@stll/workspace-ui/workspace-frame'; export const Frame=()=> <WorkspaceFrame/>;",
      },
      (directory) => {
        const result = checkRouteFallbacks(directory);
        expect(result.registeredRoutes).toBe(1);
        expect(result.census).toHaveLength(2);
        expect(result.violations).toHaveLength(1);
        expect(result.violations.at(0)).toMatchObject({
          file: "routes/index.tsx",
          kind: "pendingComponent",
        });
        expect(result.violations.at(0)?.chrome.length).toBeGreaterThan(0);
        expect(
          checkRouteFallbacks(path.relative(process.cwd(), directory))
            .violations,
        ).toEqual(result.violations);
      },
    );
  },
);

test("checks aliased Suspense and the router default, while leaving unrelated components alone", async () => {
  await withSources(
    {
      "routes/index.tsx":
        "import {Suspense as Boundary} from 'react'; import {Content} from '@/mixed'; const Page = () => <Boundary fallback={<Content/>}/>; export const Route=createFileRoute('/')({});",
      "mixed.tsx":
        "import {Sidebar} from '@/components/sidebar'; export const Frame=()=> <Sidebar/>; export const Content=()=> <main><h1>Loading</h1></main>;",
      "router.tsx":
        "import {Frame} from '@/mixed'; const router=createRouter({defaultPendingComponent:Frame});",
    },
    (directory) => {
      const result = checkRouteFallbacks(directory);
      expect(result.census).toHaveLength(2);
      expect(result.violations.map(({ kind }) => kind)).toEqual([
        "defaultPendingComponent",
      ]);
    },
  );
});

test("first frame exceptions are exact boundaries; law children and nested pending owners stay checked", async () => {
  await withSources(
    {
      "routes/__root.tsx":
        "import {Sidebar} from '@/components/sidebar'; export const Route=createRootRoute({pendingComponent:()=> <Sidebar/>});",
      "routes/-app-frame-host.tsx":
        "import * as R from 'react'; import {ProtectedPendingSkeleton} from '@/shell'; export const Host=()=> <R.Suspense fallback={<ProtectedPendingSkeleton/>}/>;",
      "shell.tsx":
        "import {Sidebar} from '@/components/sidebar'; export const ProtectedPendingSkeleton=()=> <Sidebar/>;",
      "routes/law/route.tsx":
        "import {Sidebar} from '@/components/sidebar'; export const Route=createFileRoute('/law')({pendingComponent:()=> <Sidebar/>});",
      "routes/law/index.tsx":
        "import {Sidebar} from '@/components/sidebar'; export const Route=createFileRoute('/law/')({pendingComponent:()=> <Sidebar/>});",
      "routes/law/-child.tsx":
        "import * as R from 'react'; import {Sidebar} from '@/components/sidebar'; export const Child=()=> <R.Suspense fallback={<Sidebar/>}/>;",
    },
    (directory) => {
      const result = checkRouteFallbacks(directory);
      expect(
        result.census
          .filter(({ exception }) => exception)
          .map(({ file, kind }) => `${file}#${kind}`)
          .toSorted(),
      ).toEqual(
        FIRST_FRAME_OWNERS.map(
          ({ file, kind }) => `${file}#${kind}`,
        ).toSorted(),
      );
      expect(result.violations.map(({ file }) => file).toSorted()).toEqual([
        "routes/law/-child.tsx",
        "routes/law/index.tsx",
      ]);
    },
  );
});

test.each([
  "<Sidebar/>",
  "<ProtectedPendingSkeleton><Sidebar/></ProtectedPendingSkeleton>",
  "<ProtectedPendingSkeleton content={<Sidebar/>}/>",
])(
  "a new nested boundary in the first-frame host cannot inherit its shell exception: %s",
  async (fallback) => {
    await withSources(
      {
        "routes/index.tsx": "export const Route=createFileRoute('/')({});",
        "routes/-app-frame-host.tsx": `import {Suspense} from 'react'; import {Sidebar} from '@/components/sidebar'; import {ProtectedPendingSkeleton} from '@/shell'; export const Nested=()=> <Suspense fallback={${fallback}}/>;`,
        "shell.tsx":
          "import {Sidebar} from '@/components/sidebar'; export const ProtectedPendingSkeleton=()=> <Sidebar/>;",
      },
      (directory) => {
        expect(checkRouteFallbacks(directory).violations).toMatchObject([
          {
            file: "routes/-app-frame-host.tsx",
            kind: "Suspense",
            chrome: ["@/components/sidebar#Sidebar"],
          },
        ]);
      },
    );
  },
);

test("allows content skeletons, document canvas and page toolbars without traversing unrelated shell imports", async () => {
  await withSources(
    {
      "routes/index.tsx":
        "import {Skeleton} from '@stll/ui/skeleton'; import {Content} from '@/mixed'; const Pending=()=> <div><Skeleton/><Content/></div>; export const Route=createFileRoute('/')({pendingComponent:Pending});",
      "mixed.tsx":
        "import {Sidebar} from '@/components/sidebar'; import type {Generated} from '@/generated/missing'; export const Frame=()=> <Sidebar/>; function Unrelated(){const Content=()=> <Sidebar/>; return <Content/>;} export const Content=()=> <main><header>Document toolbar</header>{identity<Generated>(<article/>)}</main>;",
    },
    (directory) => {
      const result = checkRouteFallbacks(directory);
      expect(result.census).toHaveLength(2);
      expect(result.violations).toEqual([]);
    },
  );
});

test("a missing generated census fails rather than silently validating no routes", async () => {
  await withSources(
    { "routes/index.tsx": "export const Route={};", "routeTree.gen.ts": "" },
    (directory) => {
      expect(() => checkRouteFallbacks(directory)).toThrow(
        "Route fallback census found no registered routes",
      );
    },
  );
});

test.each([
  ["named alias", "import {Loader as Pending} from '@stll/ui/loader';"],
  [
    "namespace",
    "import * as Loading from '@stll/ui/loader'; const Pending=()=> <Loading.Loader/>;",
  ],
  ["default alias", "import Pending from '@stll/ui/loader';"],
  [
    "large region",
    "import {Loader} from '@stll/ui/loader'; const Pending=()=> <Loader size='lg'/>;",
  ],
  [
    "medium row",
    "import {Loader} from '@stll/ui/loader'; const Pending=()=> <Loader size='md'/>;",
  ],
  [
    "region state",
    "import {LoaderState} from '@stll/ui/loader'; const Pending=()=> <LoaderState size='sm'/>;",
  ],
  [
    "dynamic size",
    "import {Loader} from '@stll/ui/loader'; const Pending=()=> <Loader size={loadingSize}/>;",
  ],
  [
    "spread override",
    "import {Loader} from '@stll/ui/loader'; const Pending=()=> <Loader size='sm' {...props}/>;",
  ],
  [
    "lazy named",
    "import {lazy} from 'react'; const Pending=lazy(()=> import('@stll/ui/loader').then(module=> ({default:module.Loader})));",
  ],
])(
  "rejects canonical logo Loader through %s in nested fallbacks",
  async (_name, source) => {
    await withSources(
      {
        "routes/index.tsx": `${source} export const Route=createFileRoute('/')({pendingComponent:Pending});`,
      },
      (directory) => {
        const result = checkRouteFallbacks(directory);
        expect(result.census).toHaveLength(2);
        expect(result.violations).toHaveLength(1);
        expect(result.violations.at(0)).toMatchObject({
          file: "routes/index.tsx",
          kind: "pendingComponent",
        });
        expect(result.violations.at(0)?.chrome.at(0)).toStartWith(
          "@stll/ui/loader#",
        );
      },
    );
  },
);

test("allows canonical small inline progress in content controls, including aliased and paired tags", async () => {
  await withSources(
    {
      "routes/index.tsx":
        "import {Loader as Busy} from '@stll/ui/loader'; import * as Loading from '@stll/ui/loader'; import {Inline} from '@/alias'; const Pending=()=> <main><button><Busy size='sm'/></button><Loading.Loader size={'sm'}></Loading.Loader><Inline size='sm'/></main>; export const Route=createFileRoute('/')({pendingComponent:Pending});",
      "alias.ts": "export {Loader as Inline} from '@stll/ui/loader';",
    },
    (directory) => {
      const result = checkRouteFallbacks(directory);
      expect(result.census).toHaveLength(2);
      expect(result.violations).toEqual([]);
    },
  );
});

test.each([
  [
    "named alias",
    "import {createElement as el} from 'react'; import {Sidebar as Navigation} from '@/components/sidebar'; export const Pending = <T,>() => el(Navigation);",
  ],
  [
    "namespace",
    "import * as R from 'react'; import {WorkspaceFrame as Frame} from '@stll/workspace-ui/workspace-frame'; export const Pending = <T,>() => R.createElement(Frame);",
  ],
])(
  "rejects shell construction through React createElement %s in generic TS helpers",
  async (_name, helper) => {
    await withSources(
      {
        "routes/index.tsx":
          "import {Pending} from '@/pending'; export const Route=createFileRoute('/')({pendingComponent:Pending});",
        "pending.ts": helper,
      },
      (directory) => {
        const result = checkRouteFallbacks(directory);
        expect(result.census).toHaveLength(2);
        expect(result.violations).toMatchObject([
          { file: "routes/index.tsx", kind: "pendingComponent" },
        ]);
        expect(result.violations.at(0)?.chrome.length).toBeGreaterThan(0);
      },
    );
  },
);

test("rejects raw sidebar markers while allowing page headers and complementary content", async () => {
  await withSources(
    {
      "routes/index.tsx":
        "export const Route=createFileRoute('/')({pendingComponent:()=> <div data-slot='sidebar'/>});",
      "routes/content.tsx":
        "export const Route=createFileRoute('/content')({pendingComponent:()=> <main><header>Page heading</header><aside>Complementary content</aside></main>});",
    },
    (directory) => {
      const result = checkRouteFallbacks(directory);
      expect(result.registeredRoutes).toBe(2);
      expect(result.violations).toMatchObject([
        { file: "routes/index.tsx", chrome: ["DOM#data-slot=sidebar"] },
      ]);
    },
  );
});
