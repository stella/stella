import { describe, expect, test } from "bun:test";
import path from "node:path";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

// Every form that creates something submits through `useSingleFlight`, so a
// second click or Enter in the same frame cannot create twice. This finds the
// create forms from the code: a new one fails until it uses the guard or is
// listed below with the reason it does not need it.

const SRC = path.resolve(import.meta.dir, "..");

/** Shrink-only: each entry says why the form cannot submit twice. */
const UNGUARDED_CREATE_FORMS: Record<string, string> = {
  "components/workspaces/create-matter-dialog.tsx":
    "rewritten in the open new-matter change; it adopts the guard there",
  "features/command-palette/components/upload-document-dialog.tsx":
    "a file chooser hands over one selection per event; uploads track their own batches",
};

const CREATE_HOOK_DEFINITION =
  /^export const (use(?:Create|Add)[A-Z]\w*) = /gmu;
const FORM_MARKER = /<(?:Dialog|Form)\b|onSubmit=/u;
const GUARD = /\buseSingleFlight\(/u;
// Declaring the hook is not enough: the submit has to run through it.
const GUARDED_SUBMIT = /\.(?:run|runSettled)\(/u;

/** Every source below `src`, by path, read once through the shared index. */
const productionSources = () =>
  new Map(
    sourceFileIndex(SRC)
      .filter(
        ({ relativePath }) =>
          !relativePath.includes(".test.") && !relativePath.endsWith(".gen.ts"),
      )
      .map(
        ({ relativePath, sourceText }) => [relativePath, sourceText] as const,
      ),
  );

const createHooks = (sources: ReadonlyMap<string, string>) =>
  new Set(
    [...sources.values()].flatMap((source) =>
      [...source.matchAll(CREATE_HOOK_DEFINITION)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  );

/** Create forms that do not submit through the guard. */
const unguardedCreateForms = (
  sources: ReadonlyMap<string, string>,
  hooks: ReadonlySet<string>,
): string[] => {
  const hookCall = new RegExp(`\\b(?:${[...hooks].join("|")})\\(`, "u");
  return [...sources]
    .filter(
      ([file, source]) =>
        file.endsWith(".tsx") &&
        hookCall.test(source) &&
        FORM_MARKER.test(source) &&
        !(GUARD.test(source) && GUARDED_SUBMIT.test(source)),
    )
    .map(([file]) => file)
    .toSorted();
};

describe("create forms submit once", () => {
  const sources = productionSources();
  const hooks = createHooks(sources);
  // A store, not a mutation: it opens the dialog rather than creating.
  hooks.delete("useCreateMatterStore");

  test("finds the create hooks it guards", () => {
    expect(hooks.has("useCreateContact")).toBe(true);
    expect(hooks.has("useCreateTimeEntry")).toBe(true);
  });

  test("every create form uses the guard or says why it need not", () => {
    expect(unguardedCreateForms(sources, hooks)).toEqual(
      Object.keys(UNGUARDED_CREATE_FORMS).toSorted(),
    );
  });

  test("flags a create form that skips the guard", () => {
    const fixtures = new Map([
      [
        "fixture/unguarded.tsx",
        "const create = useCreateThing();\nreturn <Dialog onSubmit={() => create.mutate()} />;",
      ],
      [
        "fixture/declared-only.tsx",
        "const create = useCreateThing();\nconst once = useSingleFlight();\nreturn <Dialog onSubmit={() => create.mutate()} />;",
      ],
      [
        "fixture/guarded.tsx",
        "const create = useCreateThing();\nconst once = useSingleFlight();\nreturn <Dialog onSubmit={() => once.run(async () => await create.mutateAsync())} />;",
      ],
    ]);
    expect(unguardedCreateForms(fixtures, new Set(["useCreateThing"]))).toEqual(
      ["fixture/declared-only.tsx", "fixture/unguarded.tsx"],
    );
  });
});
