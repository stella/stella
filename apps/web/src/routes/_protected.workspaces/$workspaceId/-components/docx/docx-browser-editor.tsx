/**
 * DocxBrowserEditor — wrapper that manages the edit session lifecycle
 * and renders the Folio DocxEditor.
 */

import { lazy, Suspense, useEffect, useRef } from "react";

import { CheckIcon, LoaderIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import type { DocxEditorRef } from "@stella/folio";
import "@stella/folio/editor.css";

import { useEditSession } from "./use-edit-session";

const DocxEditor = lazy(() =>
  import("@stella/folio").then((m) => ({ default: m.DocxEditor })),
);

type DocxBrowserEditorProps = {
  workspaceId: string;
  entityId: string;
  propertyId: string;
  onClose: () => void;
};

export const DocxBrowserEditor = ({
  workspaceId,
  entityId,
  propertyId,
  onClose,
}: DocxBrowserEditorProps) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const t = useTranslations();

  const { state, open, checkpoint, finalize, cancel } = useEditSession({
    workspaceId,
    entityId,
    propertyId,
    onFinalized: onClose,
    onCancelled: onClose,
  });

  // Auto-open the session on mount
  if (state.status === "idle") {
    void open();
  }

  // Cmd+S / Ctrl+S → checkpoint (save) instead of browser "Save Page"
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const ref = editorRef.current;
        if (ref) {
          void ref.save().then((buffer) => {
            if (buffer) {
              checkpoint(buffer);
            }
          });
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [checkpoint]);

  const handleChange = () => {
    // On each document change, serialize and queue a checkpoint
    const ref = editorRef.current;
    if (!ref) {
      return;
    }
    void ref.save({ selective: true }).then((buffer) => {
      if (buffer) {
        checkpoint(buffer);
      }
    });
  };

  const handleFinalize = async () => {
    // Save the final version before finalizing
    const ref = editorRef.current;
    if (ref) {
      const buffer = await ref.save();
      if (buffer) {
        checkpoint(buffer);
      }
    }
    await finalize();
  };

  if (state.status === "opening") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <LoaderIcon className="text-muted-foreground size-6 animate-spin" />
        <span className="text-muted-foreground text-sm">
          {t("common.loading")}
        </span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-destructive text-sm">{state.message}</p>
        <Button onClick={onClose} size="sm" variant="outline">
          {t("common.close")}
        </Button>
      </div>
    );
  }

  if (state.status === "saving") {
    return (
      <div className="flex h-full items-center justify-center gap-2">
        <LoaderIcon className="text-muted-foreground size-5 animate-spin" />
        <span className="text-muted-foreground text-sm">
          Saving...
        </span>
      </div>
    );
  }

  if (state.status !== "editing") {
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Editor toolbar actions */}
      <div className="border-b px-3 py-1.5 flex items-center justify-end gap-2">
        <Button
          onClick={() => void cancel()}
          size="sm"
          variant="ghost"
        >
          <XIcon />
          Discard
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <Button
          onClick={() => void handleFinalize()}
          size="sm"
          variant="default"
        >
          <CheckIcon />
          Done editing
        </Button>
      </div>

      {/* Folio editor */}
      <div className="flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <LoaderIcon className="text-muted-foreground size-6 animate-spin" />
              <span className="text-muted-foreground text-sm">
                Loading editor...
              </span>
            </div>
          }
        >
          <DocxEditor
            ref={editorRef}
            documentBuffer={state.buffer}
            onChange={handleChange}
            showToolbar
            loadingIndicator={
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <LoaderIcon className="text-muted-foreground size-6 animate-spin" />
                <span className="text-muted-foreground text-sm">
                  {t("folio.loadingDocument")}
                </span>
              </div>
            }
          />
        </Suspense>
      </div>
    </div>
  );
};
