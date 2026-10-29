"use dom";

import { useEffect, useEffectEvent, useState } from "react";

import type { DOMProps } from "expo/dom";

import { chunksOf, decodeChunkInto } from "./chunks";
import { DocxPages } from "./docx-pages";
import { PdfPages } from "./pdf-pages";

type DocumentViewProps = {
  kind: "docx" | "pdf";
  /** The file's size in bytes, which `readChunk` serves in slices. */
  size: number;
  /** The app's language, for the few words folio shows itself. */
  locale: string;
  /** The colour around the pages, the app's background. */
  backdrop: string;
  readChunk: (offset: number, length: number) => Promise<string>;
  /** The first page is on screen. */
  onReady: () => Promise<void>;
  onFailed: (message: string) => Promise<void>;
  dom?: DOMProps;
};

/**
 * Lets the person pinch to zoom: the page Expo serves a DOM component in
 * turns zooming off, which suits an app screen but not a document.
 */
const allowZoom = () => {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5",
    );
};

/**
 * One document, drawn by the web's own renderers: a Word document by folio,
 * laid out in pages as in the web app, and a PDF by pdf.js. Both viewers sit
 * behind this one DOM entry so the app ships one web bundle for them.
 */
const DocumentView = ({
  kind,
  size,
  locale,
  backdrop,
  readChunk,
  onReady,
  onFailed,
}: DocumentViewProps) => {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);

  const read = useEffectEvent(
    async (offset: number, length: number) => await readChunk(offset, length),
  );
  const loadFailed = useEffectEvent((error: unknown) => {
    void onFailed(String(error));
  });

  useEffect(() => {
    allowZoom();
    let cancelled = false;
    const target = new Uint8Array(size);
    const chunks = chunksOf(size);
    // One slice after another, so a single bridge message stays small.
    const load = async (index: number): Promise<void> => {
      const chunk = chunks[index];
      if (cancelled) {
        return;
      }
      if (chunk === undefined) {
        setBytes(target);
        return;
      }
      const [offset, length] = chunk;
      decodeChunkInto(await read(offset, length), target, offset);
      await load(index + 1);
    };
    load(0).catch((error: unknown) => {
      if (!cancelled) {
        loadFailed(error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [size]);

  const ready = () => {
    void onReady();
  };
  const failed = (message: string) => {
    void onFailed(message);
  };

  let pages = null;
  if (bytes !== null) {
    pages =
      kind === "pdf" ? (
        <PdfPages bytes={bytes} onFailed={failed} onReady={ready} />
      ) : (
        <DocxPages
          bytes={bytes}
          locale={locale}
          onFailed={failed}
          onReady={ready}
        />
      );
  }

  return (
    <div
      style={{
        background: backdrop,
        height: "100vh",
        overflow: "hidden",
        width: "100vw",
      }}
    >
      {pages}
    </div>
  );
};

export default DocumentView;
