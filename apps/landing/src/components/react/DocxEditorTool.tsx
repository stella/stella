import "@stll/folio-react/standalone.css";
import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { IntlProvider } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";
import { Button } from "@stll/ui/components/button";

// A real Word .docx (Y Combinator's post-money SAFE, published free to use) so
// the tool opens on a genuine, richly-formatted legal document, then lets a
// visitor open and edit their OWN .docx entirely in the browser. Both the
// default document and an opened file go through folio's `documentBuffer` path
// (`DocxInput = ArrayBuffer | Uint8Array | Blob | File`), preserving Word
// formatting; the file never leaves the browser. Served from public/samples.
const SAMPLE_DOCX_URL = "/samples/safe.docx";
const SAMPLE_DOCX_NAME = "SAFE.docx";

// folio's own canonical English strings for the "folio" namespace its
// toolbar/dialogs read via `useTranslations("folio")`; always in sync with the
// installed folio-react version. The landing has no i18n runtime wired to its
// React islands, so this island stays English-only.
const FOLIO_MESSAGES = getFolioMessages("en");

/**
 * Client-side ".docx" workbench: opens on a real sample document (a SAFE),
 * then lets a visitor open and edit their OWN .docx file entirely in the
 * browser via folio's `DocxEditor`. The picked file is read to an `ArrayBuffer`
 * with `File.arrayBuffer()` and handed to the editor through its
 * `documentBuffer` prop; it never leaves the browser — no upload, no server
 * round-trip.
 *
 * Mounted with Astro's `client:only="react"` (folio's `DocxEditor` renders a
 * real ProseMirror surface and has no server snapshot; see EditorLiveDemo's
 * note on why `client:visible` crashes under `astro build`).
 */
export const DocxEditorTool = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<EditorSource>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(SAMPLE_DOCX_URL, {
          signal: AbortSignal.timeout(10_000),
        });
        const buffer = await response.arrayBuffer();
        if (!cancelled) {
          setSource({ kind: "doc", buffer, name: SAMPLE_DOCX_NAME, loadId: 0 });
        }
      } catch {
        if (!cancelled) {
          setError("Couldn't load the sample document.");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    // `FileList` has no `.at()` in the DOM lib; index access returns `File`,
    // and the optional chain narrows the empty-selection case to `undefined`.
    const file = input.files?.[0];
    // Reset so re-picking the same file still fires `change`.
    input.value = "";
    if (!file) {
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      setSource((current) => ({
        kind: "doc",
        buffer,
        name: file.name,
        // Fresh identity per load so `DocxEditor` remounts cleanly and folio
        // treats it as a genuine external load, not an edited round-trip.
        loadId: (current.kind === "doc" ? current.loadId : 0) + 1,
      }));
      setError(null);
    } catch {
      // Never throw to the browser (no alert/confirm); surface inline and keep
      // the document currently on screen.
      setError("That file couldn't be opened. Please choose a valid .docx.");
    }
  };

  return (
    <IntlProvider
      locale="en"
      // SAFETY: `messages` is typed against the landing site's own generated
      // `Messages` catalog. `FOLIO_MESSAGES` is folio's structurally unrelated
      // "folio" namespace for this isolated island's `IntlProvider` scope, not
      // the app's catalog — same reasoning EditorLiveDemo uses for the same
      // mismatch.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      messages={FOLIO_MESSAGES as never}
    >
      <div
        className="flex h-full w-full flex-col"
        style={{ background: "var(--background)" }}
      >
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <Button
            className="h-9 text-sm sm:h-9"
            onClick={() => fileInputRef.current?.click()}
          >
            Open a .docx
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(event) => void handleFileChange(event)}
          />
          {source.kind === "doc" ? (
            <span
              className="max-w-[16rem] truncate text-xs"
              style={{ color: "var(--foreground)" }}
              title={source.name}
            >
              {source.name}
            </span>
          ) : null}
          <span
            className="text-xs"
            style={{ color: "var(--muted-foreground)" }}
          >
            Your file stays in your browser.
          </span>
          {error ? (
            <span
              className="text-xs"
              role="alert"
              style={{ color: "var(--destructive, #dc2626)" }}
            >
              {error}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <EditorSurface source={source} />
        </div>
      </div>
    </IntlProvider>
  );
};

type EditorSource =
  | { kind: "loading" }
  | { kind: "doc"; buffer: ArrayBuffer; name: string; loadId: number };

type EditorSurfaceProps = {
  source: EditorSource;
};

const EditorSurface = ({ source }: EditorSurfaceProps) => {
  if (source.kind === "loading") {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-sm"
        style={{ color: "var(--muted-foreground)" }}
      >
        Loading the editor…
      </div>
    );
  }

  return (
    <DocxEditor
      // Remount per load so folio re-parses the freshly opened bytes.
      key={`doc-${source.loadId}`}
      className="folio-docx-preview h-full"
      documentBuffer={source.buffer}
      documentKey={`docx-editor-tool-${source.loadId}`}
      // Fit each opened document to the workbench width so it never overflows
      // and clips on the right; folio re-fits on resize.
      initialZoom="fit-width"
      showOutline={false}
    />
  );
};
