import React, { useState, useRef, useCallback, useEffect } from "react";

import { DocxEditor, createEmptyDocument } from "@stll/folio";
import type {
  Document as FolioDocument,
  DocxEditorRef,
  EditorMode,
} from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Separator } from "@stll/ui/components/separator";
import { EyeIcon, MinusIcon, PenLineIcon, PlusIcon } from "lucide-react";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const ZOOM_INITIAL = 1;

function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
}

declare global {
  var __folioPlayground:
    | {
        getEditorRef: () => DocxEditorRef | null;
      }
    | undefined;
}

function createLargeDocument(paragraphCount: number): FolioDocument {
  const document = createEmptyDocument();
  const paragraphs: FolioDocument["package"]["document"]["content"] = [];

  for (let i = 0; i < paragraphCount; i += 1) {
    paragraphs.push({
      type: "paragraph",
      content: [
        {
          type: "run",
          content: [
            {
              type: "text",
              text: `Performance paragraph ${i + 1}: This legal drafting fixture provides enough body text to exercise paged layout measurement.`,
            },
          ],
          formatting: {
            fontSize: 22,
            fontFamily: {
              ascii: "Arial",
              hAnsi: "Arial",
            },
          },
        },
      ],
      formatting: {
        lineSpacing: 276,
      },
    });
  }

  document.package.document.content = paragraphs;
  return document;
}

export function App() {
  const editorRef = useRef<DocxEditorRef>(null);
  const [currentDocument, setCurrentDocument] = useState<FolioDocument | null>(
    null,
  );
  const [documentBuffer, setDocumentBuffer] = useState<ArrayBuffer | null>(
    null,
  );
  const [fileName, setFileName] = useState("Untitled.docx");
  const [status, setStatus] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("editing");
  const [zoom, setZoom] = useState(ZOOM_INITIAL);

  // Load fixture from ?file= query param (for visual regression tests)
  // or from /fixtures/*.docx (served by Vite's public dir)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fixtureFile = params.get("file");
    const paragraphCount = Number(params.get("paragraphs"));
    if (fixtureFile) {
      void (async () => {
        try {
          setStatus("Loading fixture...");
          const response = await fetch(`/fixtures/${fixtureFile}`);
          if (!response.ok) {
            setStatus(`Fixture not found: ${fixtureFile}`);
            return;
          }
          const buffer = await response.arrayBuffer();
          setCurrentDocument(null);
          setDocumentBuffer(buffer);
          setFileName(fixtureFile);
          setStatus("");
        } catch {
          setStatus("Error loading fixture");
        }
      })();
      return;
    }
    if (Number.isInteger(paragraphCount) && paragraphCount > 0) {
      setCurrentDocument(createLargeDocument(paragraphCount));
      setFileName(`Generated ${paragraphCount} paragraphs.docx`);
      return;
    }
    setCurrentDocument(createEmptyDocument());
    setFileName("Untitled.docx");
  }, []);

  const handleNewDocument = useCallback(() => {
    setCurrentDocument(createEmptyDocument());
    setDocumentBuffer(null);
    setFileName("Untitled.docx");
    setStatus("");
  }, []);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      try {
        setStatus("Loading...");
        const buffer = await file.arrayBuffer();
        setCurrentDocument(null);
        setDocumentBuffer(buffer);
        setFileName(file.name);
        setStatus("");
      } catch {
        setStatus("Error loading file");
      }
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!editorRef.current) {
      return;
    }
    try {
      setStatus("Saving...");
      const buffer = await editorRef.current.save();
      if (buffer) {
        const blob = new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName || "document.docx";
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatus("Saved!");
        setTimeout(() => setStatus(""), 2000);
      }
    } catch {
      setStatus("Save failed");
    }
  }, [fileName]);

  const handleError = useCallback((error: Error) => {
    setStatus(`Error: ${error.message}`);
  }, []);

  const applyZoom = useCallback((next: number) => {
    const clamped = clampZoom(next);
    setZoom(clamped);
    editorRef.current?.setZoom(clamped);
  }, []);
  const handleZoomIn = useCallback(
    () => applyZoom(zoom + ZOOM_STEP),
    [applyZoom, zoom],
  );
  const handleZoomOut = useCallback(
    () => applyZoom(zoom - ZOOM_STEP),
    [applyZoom, zoom],
  );
  const handleZoomReset = useCallback(
    () => applyZoom(ZOOM_INITIAL),
    [applyZoom],
  );

  const toggleDarkMode = useCallback(() => {
    document.documentElement.classList.toggle("dark");
  }, []);

  const trackChangesOn = editorMode === "suggesting";

  useEffect(() => {
    globalThis.__folioPlayground = {
      getEditorRef: () => editorRef.current,
    };
    return () => {
      delete globalThis.__folioPlayground;
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <main className="flex flex-1 overflow-hidden">
        <DocxEditor
          ref={editorRef}
          document={documentBuffer ? undefined : currentDocument}
          documentBuffer={documentBuffer}
          author="Folio User"
          onError={handleError}
          showToolbar={true}
          initialZoom={ZOOM_INITIAL}
          mode={editorMode}
          onModeChange={setEditorMode}
        />
      </main>

      {/* Dev controls bar */}
      <div className="border-border bg-background flex items-center gap-2 border-t px-4 py-1.5">
        <Button
          variant={trackChangesOn ? "default" : "ghost"}
          size="sm"
          onClick={() =>
            setEditorMode(trackChangesOn ? "editing" : "suggesting")
          }
        >
          <PenLineIcon />
          {trackChangesOn ? "Tracking" : "Track Changes"}
        </Button>
        <Button
          variant={editorMode === "viewing" ? "default" : "ghost"}
          size="sm"
          onClick={() =>
            setEditorMode(editorMode === "viewing" ? "editing" : "viewing")
          }
        >
          <EyeIcon />
          View Only
        </Button>

        <Separator orientation="vertical" className="h-5" />

        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            document.querySelector<HTMLInputElement>("#file-input")?.click()
          }
        >
          Open
        </Button>
        <input
          id="file-input"
          type="file"
          accept=".docx"
          onChange={(e) => void handleFileSelect(e)}
          className="hidden"
        />
        <Button variant="ghost" size="sm" onClick={handleNewDocument}>
          New
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void handleSave()}>
          Save
        </Button>

        <Separator orientation="vertical" className="h-5" />

        <Button
          variant="ghost"
          size="sm"
          onClick={handleZoomOut}
          disabled={zoom <= ZOOM_MIN}
          title="Zoom out"
        >
          <MinusIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleZoomReset}
          title="Reset zoom"
          className="min-w-12 font-mono text-xs"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleZoomIn}
          disabled={zoom >= ZOOM_MAX}
          title="Zoom in"
        >
          <PlusIcon />
        </Button>

        <Separator orientation="vertical" className="h-5" />

        <Button variant="ghost" size="sm" onClick={toggleDarkMode}>
          ◐
        </Button>

        {status && (
          <span className="text-muted-foreground text-xs">{status}</span>
        )}
        <span className="text-muted-foreground ml-auto font-mono text-xs">
          {fileName}
        </span>
      </div>
    </div>
  );
}
