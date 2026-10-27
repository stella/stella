import { renderToStaticMarkup } from "react-dom/server";

import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IntlProvider } from "use-intl";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { repoRelativePath } from "@stll/portable-path";
import {
  isObjectLiteralProperty,
  type Node,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

import type { Decision } from "@/features/case-law/components/decision-cells";
import {
  answerKey,
  type QuestionAnswer,
} from "@/features/case-law/research/question-columns.logic";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";

// Match Vite's asset URL transform; no worker or PDF is executed by a cell.
plugin({
  name: "ai-cell-host-worker-url",
  setup(build) {
    build.onLoad({ filter: /\?worker&url$/u }, () => ({
      contents: 'export default "/worker.js";',
      loader: "js",
    }));
  },
});
const { QuestionCell } =
  await import("@/features/case-law/research/question-cell");
const { PropertyCell } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/table-column-cells");

const sourceRoot = path.resolve(import.meta.dir, "../..");

const decision = {
  id: "synthetic-decision",
  caseNumber: "SYN-1",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  slug: null,
  ecli: null,
  court: "Synthetic court",
  country: "CZE",
  language: "en",
  languageAlternates: [],
  decisionDate: null,
  decisionType: null,
  headnote: { type: "absent", reason: "not_published" },
  citationCount: 0,
} satisfies Decision;
const question = {
  id: "synthetic-question",
  question: "Synthetic question",
  content: { version: 1, type: "text" },
} as const;
const answer = {
  columnId: question.id,
  decisionId: decision.id,
  state: "pending",
  stale: false,
  answer: null,
  failureReason: null,
} satisfies QuestionAnswer;
const property = {
  id: toSafeId<"property">("synthetic-property"),
  name: "Synthetic property",
  createdAt: "2026-01-01T00:00:00Z",
  workspaceId: toSafeId<"workspace">("synthetic-matter"),
  status: "fresh",
  kinds: null,
  content: { version: 1, type: "text" },
  tool: {
    version: 1,
    type: "ai-model",
    prompt: "Synthetic prompt",
    dependencies: [],
  },
} as const satisfies WorkspaceProperty;
const entity = {
  entityId: toSafeId<"entity">("synthetic-document"),
  kind: "document",
  name: "Synthetic document",
  parentId: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  createdByUserId: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  currentVersionReference: null,
  status: null,
  priority: null,
  listItemType: "task",
  dueDate: null,
  agendaKind: "task",
  startAt: null,
  endAt: null,
  occurredAt: null,
  remindAt: null,
  allDay: false,
  timeZone: null,
  location: null,
  onlineMeetingUrl: null,
  availability: null,
  sensitivity: null,
  organizer: null,
  attendees: null,
  recurrence: null,
  agendaSource: "manual",
  externalSource: null,
  externalId: null,
  externalChangeKey: null,
  externalICalUid: null,
  readOnly: false,
  sortOrder: null,
  activeEditBy: null,
  fields: {},
  cellMetadata: {},
  assignees: [],
} satisfies WorkspaceEntity;

const fixtures = {
  QuestionCell: () => (
    <QuestionCell
      answersByKey={new Map([[answerKey(question.id, decision.id), answer]])}
      column={question}
      decision={decision}
      onShowPassage={() => undefined}
    />
  ),
  PropertyCell: () => (
    <PropertyCell
      entity={{
        ...entity,
        fields: {
          [property.id]: {
            entityId: entity.entityId,
            id: toSafeId<"field">("synthetic-field"),
            propertyId: property.id,
            content: { type: "pending", version: 1 },
          },
        },
      }}
      property={property}
    />
  ),
};

type SourceModule = {
  dependencies: Set<string>;
  adapters: Set<string>;
  mountsTable: boolean;
  ownsAiColumnFactory: boolean;
};

const readSources = () => {
  const sources = new Map<string, string>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({
    cwd: sourceRoot,
  })) {
    if (/\.(test|gen)\./u.test(file)) {
      continue;
    }
    sources.set(file, readFileSync(path.join(sourceRoot, file), "utf-8"));
  }
  return sources;
};

// Factories are identified independently of lifecycle rendering. Removing
// AiCell must leave its AI table hosts in the census, with missing adapters.
const sourceCensus = (sources: ReadonlyMap<string, string>) => {
  const modules = new Map<string, SourceModule>();
  for (const [file, text] of sources) {
    const source = parseSource(file, text);
    const dependencies = new Set<string>();
    const aiCellNames = new Set<string>();
    const tableNames = new Set<string>();
    const adapters = new Set<string>();
    let mountsTable = false;
    let ownsAiColumnFactory = false;
    for (const statement of source.module.staticImports) {
      const named = statement.entries.filter(
        (entry) => entry.importName.name !== null,
      );
      // `{ … }` with no named entry (`import {} from`) still counts as a
      // type-only binding list, while a side-effect import has none.
      const hasNamedBindings =
        named.length > 0 ||
        source.sourceText
          .slice(statement.start, statement.moduleRequest.start)
          .includes("{");
      // `isType` marks every binding of `import type …` and each inline
      // `type` binding; a type-only import carries no runtime dependency.
      if (
        (statement.entries.length > 0 &&
          statement.entries.every((entry) => entry.isType)) ||
        (hasNamedBindings && named.every((entry) => entry.isType))
      ) {
        continue;
      }
      const specifier = statement.moduleRequest.value;
      let resolved: string | undefined;
      if (specifier.startsWith("@/")) {
        resolved = path.resolve(sourceRoot, specifier.slice(2));
      } else if (specifier.startsWith(".")) {
        resolved = path.resolve(sourceRoot, path.dirname(file), specifier);
      }
      if (resolved === undefined) {
        continue;
      }
      const target = repoRelativePath(sourceRoot, resolved);
      dependencies.add(target);
      const exports = new Set<string>();
      switch (target) {
        case "components/workspaces/ai-cell":
          exports.add("AiCell");
          break;
        case "components/workspaces/table/workspace-table/workspace-table":
          exports.add("WorkspaceTable");
          break;
        case "components/public-law-table/public-law-table":
          exports.add("PublicLawTable");
          break;
        default:
          break;
      }
      const names =
        target === "components/workspaces/ai-cell" ? aiCellNames : tableNames;
      for (const entry of statement.entries) {
        if (entry.isType) {
          continue;
        }
        if (
          entry.importName.name !== null &&
          exports.has(entry.importName.name)
        ) {
          names.add(entry.localName.value);
        }
        // oxc-parser declares ImportNameKind as an ambient const enum of
        // strings.
        const kind: string = entry.importName.kind;
        if (kind === "NamespaceObject") {
          for (const name of exports) {
            names.add(`${entry.localName.value}.${name}`);
          }
        }
      }
    }
    const hasCellFactory = (root: Node): boolean => {
      let found = false;
      walk(root, (node, ancestors) => {
        if (
          found ||
          (isObjectLiteralProperty(node, ancestors.at(-1)) &&
            node.kind === "init" &&
            !node.method &&
            !node.shorthand &&
            !node.computed &&
            source.sourceText.slice(node.key.start, node.key.end) === "cell") ||
          (node.type === "CallExpression" &&
            node.callee.type === "Identifier" &&
            node.callee.name === "getPropertyColumnRender")
        ) {
          found = true;
          return "skip-children";
        }
        return undefined;
      });
      return found;
    };
    // Each node's owner is the nearest enclosing named variable or function
    // declaration, the node itself included.
    const ownerOf = (node: Node, ancestors: readonly Node[]) => {
      for (const current of [...ancestors, node].toReversed()) {
        if (
          current.type === "VariableDeclarator" &&
          current.id.type === "Identifier"
        ) {
          return current.id.name;
        }
        if (current.type === "FunctionDeclaration") {
          return current.id?.name;
        }
      }
      return undefined;
    };
    walk(source.program, (node, ancestors) => {
      if (
        node.type === "SwitchCase" &&
        node.test?.type === "Literal" &&
        (node.test.value === "question" || node.test.value === "property") &&
        hasCellFactory(node)
      ) {
        ownsAiColumnFactory = true;
      }
      if (node.type === "JSXOpeningElement") {
        const tag = source.sourceText.slice(node.name.start, node.name.end);
        const owner = ownerOf(node, ancestors);
        if (aiCellNames.has(tag) && owner !== undefined) {
          adapters.add(owner);
        }
        if (tableNames.has(tag)) {
          mountsTable = true;
        }
      }
    });
    modules.set(file.replace(/\.tsx?$/u, ""), {
      dependencies,
      adapters,
      mountsTable,
      ownsAiColumnFactory,
    });
  }
  const reachableModules = (
    file: string,
    seen = new Set<string>(),
  ): Set<string> => {
    if (seen.has(file)) {
      return seen;
    }
    seen.add(file);
    for (const dependency of modules.get(file)?.dependencies ?? []) {
      reachableModules(dependency, seen);
    }
    return seen;
  };
  const adapters = new Set(
    [...modules.values()].flatMap((module) => [...module.adapters]),
  );
  const hosts = [...modules]
    .filter(([, module]) => module.mountsTable)
    .map(([file]) => {
      const reachable = [...reachableModules(file)].flatMap((dependency) => {
        const module = modules.get(dependency);
        return module === undefined ? [] : [module];
      });
      return {
        file,
        ownsAiColumns: reachable.some((module) => module.ownsAiColumnFactory),
        adapters: new Set(reachable.flatMap((module) => [...module.adapters])),
      };
    })
    .filter((host) => host.ownsAiColumns);
  return { adapters, hosts };
};

const assertHostsUseSharedAdapters = (
  census: ReturnType<typeof sourceCensus>,
) => {
  for (const host of census.hosts) {
    expect(
      host.adapters.size,
      `${host.file} must reach a shared AI adapter`,
    ).toBeGreaterThan(0);
  }
};

describe("AI table host census", () => {
  test.each([
    { declaration: 'import columns from "./factory";', runtime: true },
    { declaration: 'import { columns } from "./factory";', runtime: true },
    { declaration: 'import * as columns from "./factory";', runtime: true },
    {
      declaration: 'import columns, { type Shape } from "./factory";',
      runtime: true,
    },
    {
      declaration:
        'import columns, { type Shape, type Other } from "./factory";',
      runtime: true,
    },
    { declaration: 'import {} from "./factory";', runtime: true },
    { declaration: 'import "./factory";', runtime: true },
    { declaration: 'import { type Shape } from "./factory";', runtime: false },
    { declaration: 'import type columns from "./factory";', runtime: false },
    { declaration: 'import type { Shape } from "./factory";', runtime: false },
    { declaration: 'import type {} from "./factory";', runtime: false },
  ])(
    "preserves runtime dependency semantics for $declaration",
    ({ declaration, runtime }) => {
      const census = sourceCensus(
        new Map([
          [
            "synthetic/adapter.tsx",
            'import { AiCell } from "@/components/workspaces/ai-cell"; export const SyntheticCell = () => <AiCell state={{type: "running"}} />;',
          ],
          [
            "synthetic/factory.tsx",
            'import { SyntheticCell } from "./adapter"; export const columns = (kind) => { switch(kind) { case "question": return { cell: () => <SyntheticCell /> }; } };',
          ],
          [
            "synthetic/host.tsx",
            `import { PublicLawTable } from "@/components/public-law-table/public-law-table"; ${declaration} export const Host = () => <PublicLawTable />;`,
          ],
        ]),
      );
      expect(census.hosts.map((host) => host.file)).toEqual(
        runtime ? ["synthetic/host"] : [],
      );
      if (runtime) {
        expect([...census.hosts.flatMap((host) => [...host.adapters])]).toEqual(
          ["SyntheticCell"],
        );
      }
    },
  );
  test("discovers aliased and namespace table hosts even when their shared adapter is removed", () => {
    const sources = new Map([
      [
        "synthetic/adapter.tsx",
        'import * as Cells from "@/components/workspaces/ai-cell"; export const SyntheticCell = () => <Cells.AiCell state={{type: "running"}} />;',
      ],
      [
        "synthetic/factory.tsx",
        'import { SyntheticCell } from "./adapter"; export const columns = (kind) => { switch(kind) { case "question": return { cell: () => <SyntheticCell /> }; } };',
      ],
      [
        "synthetic/alias-host.tsx",
        'import { PublicLawTable as AliasTable } from "@/components/public-law-table/public-law-table"; import { columns } from "./factory"; export const Host = () => <AliasTable columns={columns("question")} />;',
      ],
      [
        "synthetic/namespace-host.tsx",
        'import * as Tables from "@/components/workspaces/table/workspace-table/workspace-table"; import { columns } from "./factory"; export const Host = () => <Tables.WorkspaceTable columns={columns("question")} />;',
      ],
    ]);
    const valid = sourceCensus(sources);
    expect(valid.hosts.map((host) => host.file).toSorted()).toEqual([
      "synthetic/alias-host",
      "synthetic/namespace-host",
    ]);
    expect([...valid.adapters]).toEqual(["SyntheticCell"]);
    assertHostsUseSharedAdapters(valid);
    sources.set(
      "synthetic/adapter.tsx",
      "export const SyntheticCell = () => <span />;",
    );
    const broken = sourceCensus(sources);
    expect(broken.hosts.map((host) => host.file)).toEqual(
      valid.hosts.map((host) => host.file),
    );
    expect(() => assertHostsUseSharedAdapters(broken)).toThrow(
      "must reach a shared AI adapter",
    );
  });
  test("every discovered AI table host reaches an adapter with visible running feedback", () => {
    const census = sourceCensus(readSources());
    expect([...census.adapters].toSorted()).toEqual(
      Object.keys(fixtures).toSorted(),
    );
    expect(census.hosts.length).toBeGreaterThan(0);
    assertHostsUseSharedAdapters(census);
    const exercised = new Set<string>();
    for (const [name, render] of Object.entries(fixtures)) {
      const html = renderToStaticMarkup(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {render()}
        </IntlProvider>,
      );
      expect(html).toContain('data-ai-cell-state="running"');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain("Answering…");
      expect(html).toContain("<svg");
      exercised.add(name);
    }
    for (const host of census.hosts) {
      for (const adapter of host.adapters) {
        expect(
          exercised.has(adapter),
          `${host.file} mounts untested ${adapter}`,
        ).toBe(true);
      }
    }
  });
});
