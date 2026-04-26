import React, { useState, useRef, useCallback, useEffect } from "react";

import { DocxEditor, createEmptyDocument } from "@stella/folio";
import type { DocxEditorRef, EditorMode } from "@stella/folio";
import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";
import { PenLineIcon, EyeIcon } from "lucide-react";

export function App() {
  const editorRef = useRef<DocxEditorRef>(null);
  const [currentDocument, setCurrentDocument] = useState<Document | null>(null);
  const [documentBuffer, setDocumentBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("Untitled.docx");
  const [status, setStatus] = useState<string>("");
  const [editorMode, setEditorMode] = useState<EditorMode>("editing");

  // Load fixture from ?file= query param (for visual regression tests)
  // or from /fixtures/*.docx (served by Vite's public dir)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fixtureFile = params.get("file");
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
      if (!file) return;
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
    if (!editorRef.current) return;
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
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus("Saved!");
        setTimeout(() => setStatus(""), 2000);
      }
    } catch {
      setStatus("Save failed");
    }
  }, [fileName]);

  const handleError = useCallback((error: Error) => {
    console.error("Editor error:", error);
    setStatus(`Error: ${error.message}`);
  }, []);

  const toggleDarkMode = useCallback(() => {
    document.documentElement.classList.toggle("dark");
  }, []);

  const trackChangesOn = editorMode === "suggesting";

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <main className="flex flex-1 overflow-hidden">
        <DocxEditor
          ref={editorRef}
          document={documentBuffer ? undefined : (currentDocument as never)}
          documentBuffer={documentBuffer}
          author="Folio User"
          onError={handleError}
          showToolbar={true}
          mode={editorMode}
          onModeChange={setEditorMode}
        />
      </main>

      {/* Dev controls bar */}
      <div className="flex items-center gap-2 border-t border-border bg-background px-4 py-1.5">
        <Button
          variant={trackChangesOn ? "default" : "ghost"}
          size="sm"
          onClick={() => setEditorMode(trackChangesOn ? "editing" : "suggesting")}
        >
          <PenLineIcon />
          {trackChangesOn ? "Tracking" : "Track Changes"}
        </Button>
        <Button
          variant={editorMode === "viewing" ? "default" : "ghost"}
          size="sm"
          onClick={() => setEditorMode(editorMode === "viewing" ? "editing" : "viewing")}
        >
          <EyeIcon />
          View Only
        </Button>

        <Separator orientation="vertical" className="h-5" />

        <Button variant="ghost" size="sm" onClick={() => document.getElementById("file-input")?.click()}>Open</Button>
        <input id="file-input" type="file" accept=".docx" onChange={handleFileSelect} className="hidden" />
        <Button variant="ghost" size="sm" onClick={handleNewDocument}>New</Button>
        <Button variant="ghost" size="sm" onClick={handleSave}>Save</Button>

        <Separator orientation="vertical" className="h-5" />

        <Button variant="ghost" size="sm" onClick={toggleDarkMode}>◐</Button>

        {status && <span className="text-xs text-muted-foreground">{status}</span>}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{fileName}</span>
      </div>
    </div>
  );
}
