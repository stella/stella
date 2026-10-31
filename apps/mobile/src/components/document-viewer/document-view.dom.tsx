"use dom";

import { useEffect, useEffectEvent, useState } from "react";

import type { DOMProps } from "expo/dom";

import { useDomAppearance } from "@/components/dom-theme";
import type { DomAppearance } from "@/components/dom-theme";

import { chunksOf, decodeChunkInto } from "./chunks";
import { DocxPages } from "./docx-pages";
import { PdfPages } from "./pdf-pages";

type DocumentViewProps = {
  kind: "docx" | "pdf";
  /** The file's size in bytes, which `readChunk` serves in slices. */
  size: number;
  /** The app's language, for the few words folio shows itself. */
  locale: string;
  /**
   * The app's appearance. folio and the PDF pages read stella's colour
   * tokens and its `dark` class, as on the web.
   */
  appearance: DomAppearance;
  /** The pages' width as a factor of the screen's fit (see ./zoom.ts). */
  zoom: number;
  readChunk: (offset: number, length: number) => Promise<string>;
  /**
   * The first page is on screen. The app's handlers only set state, so the
   * DOM side does not wait on the bridge's reply.
   */
  onReady: () => void;
  onFailed: (message: string) => void;
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
 * The canvas around the pages, as folio draws its own: the muted tint over
 * the background, so a white page stands apart in light and a dark one in
 * dark.
 */
const CANVAS = "linear-gradient(var(--muted), var(--muted)) var(--background)";

/**
 * One document, drawn by the web's own renderers: a Word document by folio,
 * laid out in pages as in the web app, and a PDF by pdf.js. Both viewers sit
 * behind this one DOM entry so the app ships one web bundle for them.
 */
const DocumentView = ({
  kind,
  size,
  locale,
  appearance,
  zoom,
  readChunk,
  onReady,
  onFailed,
}: DocumentViewProps) => {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);

  const read = useEffectEvent(
    async (offset: number, length: number) => await readChunk(offset, length),
  );
  const loadFailed = useEffectEvent((error: unknown) => {
    onFailed(String(error));
  });

  useDomAppearance(appearance);

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
    onReady();
  };
  const failed = (message: string) => {
    onFailed(message);
  };

  let pages = null;
  if (bytes !== null) {
    pages =
      kind === "pdf" ? (
        <PdfPages
          bytes={bytes}
          invert={appearance === "dark"}
          onFailed={failed}
          onReady={ready}
          zoom={zoom}
        />
      ) : (
        <DocxPages
          bytes={bytes}
          locale={locale}
          onFailed={failed}
          onReady={ready}
          zoom={zoom}
        />
      );
  }

  return (
    <div
      style={{
        background: CANVAS,
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
