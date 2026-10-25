import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

// Every module that reads a file to display it must sit under
// RecoverableViewerBoundary, so no viewer can dead-end on a failed load.
// This guard finds the readers from the code: a new one fails until it is
// listed here with how it recovers.

const SRC = path.resolve(import.meta.dir, "../..");
const BOUNDARY_MODULE = "@/components/viewer/recoverable-viewer-boundary";

/** Query options that fetch file bytes or a file's rendered content. */
const VIEWER_DATA_OPTIONS = new Set([
  "fileOptions",
  "emailHtmlPreviewOptions",
  "emailAttachmentPreviewOptions",
  "externalReferencePreviewOptions",
  "textFileOptions",
]);

const readsViewerData = (source: string): boolean => {
  const file = ts.createSourceFile(
    "viewer.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const isViewerOptions = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    VIEWER_DATA_OPTIONS.has(node.expression.text);
  const visit = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "useQuery" ||
        node.expression.text === "useSuspenseQuery")
    ) {
      const options = node.arguments.at(0);
      if (
        options &&
        (isViewerOptions(options) ||
          (ts.isObjectLiteralExpression(options) &&
            options.properties.some(
              (property) =>
                ts.isSpreadAssignment(property) &&
                isViewerOptions(property.expression),
            )))
      ) {
        return true;
      }
    }
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(file);
};

type ViewerCoverage =
  /** Rendered only under the boundary, which `owner` mounts. */
  | { type: "boundary"; owner: string }
  /** Recovers through its own retry today; moves to the boundary next. */
  | { type: "pending"; reason: string }
  | { type: "not-a-viewer"; reason: string };

const PDF_PROVIDER = "lib/pdf/pdf-context.tsx";
const DOCUMENT_ROUTE =
  "routes/_protected.workspaces/$workspaceId/$viewId.document.tsx";

const VIEWER_DATA_READERS: Record<string, ViewerCoverage> = {
  [DOCUMENT_ROUTE]: { type: "boundary", owner: DOCUMENT_ROUTE },
  "components/pdf/pdf-viewer.tsx": { type: "boundary", owner: PDF_PROVIDER },
  "components/pdf/page-organizer.tsx": {
    type: "boundary",
    owner: PDF_PROVIDER,
  },
  "components/chat/create-document-draft-inspector-editor.tsx": {
    type: "boundary",
    owner: "components/chat/create-document-draft-inspector-view.tsx",
  },
  "components/inspector/plain-text-file-viewer.tsx": {
    type: "boundary",
    owner: "components/inspector/plain-text-file-viewer.tsx",
  },
  "components/office/office-file-viewer.tsx": {
    type: "pending",
    reason:
      "full-screen mount is under the boundary; the inspector mount uses QuerySuspenseBoundary with retry",
  },
  "components/docx/use-docx-preview-file.ts": {
    type: "pending",
    reason: "DocxBrowserEditor's QuerySuspenseBoundary offers try again",
  },
  "components/pdf/peek/peek-pdf-viewer.tsx": {
    type: "pending",
    reason: "peek QuerySuspenseBoundary offers try again",
  },
  "components/inspector/email-html-viewer.tsx": {
    type: "pending",
    reason: "inline error state refetches on try again",
  },
  "components/inspector/email-attachments-facet.tsx": {
    type: "pending",
    reason: "inline error message; attachment save stays available",
  },
  "components/inspector/external-reference-panel.tsx": {
    type: "pending",
    reason: "unavailable state opens the original source",
  },
  "components/inspector/use-markdown-file-draft.ts": {
    type: "pending",
    reason: "markdown viewer's inline error refetches on retry",
  },
  "components/inspector/pdf-sign-placement.tsx": {
    type: "pending",
    reason: "signing placement preview reports its own failure",
  },
  "features/avt/original-pdf-view.tsx": {
    type: "not-a-viewer",
    reason:
      "reads the PDF for claim boxes; the PeekPdfViewer it mounts shows the file and its load failure",
  },
  "hooks/use-verified-email-citation-target.ts": {
    type: "not-a-viewer",
    reason: "resolves a citation target; renders no file",
  },
};

/** Shrink-only: migrate a pending reader, then lower this number. */
const MAX_PENDING_READERS = 8;

const listSourceFiles = (): string[] =>
  [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })].filter(
    (file) => !file.includes(".test.") && !file.endsWith(".gen.ts"),
  );

const read = (file: string): string =>
  readFileSync(path.join(SRC, file), "utf-8");

describe("viewer error coverage", () => {
  const readers = listSourceFiles()
    .filter((file) => readsViewerData(read(file)))
    .toSorted();

  test("every module that reads a file for display is listed", () => {
    expect(readers).toEqual(Object.keys(VIEWER_DATA_READERS).toSorted());
  });

  test("every boundary owner mounts RecoverableViewerBoundary", () => {
    const owners = new Set(
      Object.values(VIEWER_DATA_READERS).flatMap((coverage) =>
        coverage.type === "boundary" ? [coverage.owner] : [],
      ),
    );
    for (const owner of owners) {
      const source = read(owner);
      expect({ owner, mounts: source.includes(BOUNDARY_MODULE) }).toEqual({
        owner,
        mounts: true,
      });
      expect({
        owner,
        renders: source.includes("<RecoverableViewerBoundary"),
      }).toEqual({ owner, renders: true });
    }
  });

  test("pending readers only shrink", () => {
    const pending = Object.values(VIEWER_DATA_READERS).filter(
      (coverage) => coverage.type === "pending",
    );
    expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_READERS);
  });

  test("the scan recognises readers across query option layouts", () => {
    for (const hook of ["useQuery", "useSuspenseQuery"]) {
      for (const factory of VIEWER_DATA_OPTIONS) {
        for (const options of [
          `${factory}({ workspaceId, fieldId })`,
          `{ ...${factory}({ workspaceId, fieldId }), enabled: true }`,
          `{ /* cached bytes */ initialData: () => cached, ...${factory}({ workspaceId, fieldId }) }`,
          `{ // cached bytes\n initialData: () => ({ value: cached }), ...${factory}({ workspaceId, fieldId }), placeholderData: previous }`,
        ]) {
          expect(readsViewerData(`${hook}(${options});`)).toBe(true);
        }
      }
    }
    for (const source of [
      "queryClient.prefetchQuery(fileOptions(x))",
      "useQuery({ queryFn: () => fileOptions(x) })",
      "// useQuery(fileOptions(x))",
      'const example = "useQuery(fileOptions(x))";',
    ]) {
      expect(readsViewerData(source)).toBe(false);
    }
  });
});
