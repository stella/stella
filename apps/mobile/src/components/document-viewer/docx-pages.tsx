import { useEffect, useEffectEvent, useRef, useState } from "react";

import { IntlProvider } from "use-intl";
import type { AbstractIntlMessages } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import type { DocxEditorRef } from "@stll/folio-react";
import ar from "@stll/folio-react/messages/ar";
import cs from "@stll/folio-react/messages/cs";
import de from "@stll/folio-react/messages/de";
import en from "@stll/folio-react/messages/en";
import es from "@stll/folio-react/messages/es";
import et from "@stll/folio-react/messages/et";
import fr from "@stll/folio-react/messages/fr";
import hu from "@stll/folio-react/messages/hu";
import lt from "@stll/folio-react/messages/lt";
import lv from "@stll/folio-react/messages/lv";
import pl from "@stll/folio-react/messages/pl";
import ptBR from "@stll/folio-react/messages/pt-BR";
import sk from "@stll/folio-react/messages/sk";
import { resolveUiLocale } from "@stll/locales";
import type { UiLocale } from "@stll/locales";

import "@stll/folio-react/editor.css";

import { bundledFontUrl } from "@/components/dom-theme";

import { FOLIO_FONT_FACES } from "./folio-fonts.gen";
import { docxZoomTarget } from "./zoom";

/** folio's own words in every language the app ships. */
const FOLIO_CATALOGS = {
  ar,
  cs,
  de,
  en,
  es,
  et,
  fr,
  hu,
  lt,
  lv,
  pl,
  "pt-BR": ptBR,
  sk,
} as const satisfies Record<UiLocale, typeof en>;

/**
 * Declares folio's faces from the bundled font files. Metro drops the
 * `url()` sources of the @font-face rules in folio's stylesheet, so without
 * these a Calibri document would lay out in a system font's metrics.
 */
let fontsDeclared = false;

const declareFolioFonts = () => {
  if (fontsDeclared) {
    return;
  }
  fontsDeclared = true;
  const rules = FOLIO_FONT_FACES.flatMap((face) => {
    const url = bundledFontUrl(face.source);
    return url === null
      ? []
      : [
          `@font-face{font-family:${JSON.stringify(face.family)};font-style:${face.style};font-weight:${String(face.weight)};font-display:block;src:url(${JSON.stringify(url)}) format("woff2");unicode-range:${face.unicodeRange};}`,
        ];
  });
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.append(style);
};

/**
 * A Word document laid out in pages by folio, read-only, as the web shows it,
 * `zoom` times the width folio fits the page to.
 */
export const DocxPages = ({
  bytes,
  locale,
  zoom,
  onReady,
  onFailed,
}: {
  bytes: Uint8Array;
  locale: string;
  /** The page's width as a factor of folio's fit (see ./zoom.ts). */
  zoom: number;
  onReady: () => void;
  onFailed: (message: string) => void;
}) => {
  const [uiLocale] = useState(() => resolveUiLocale(locale) ?? "en");
  // folio's own catalogue, not the app's: this provider serves folio alone.
  const messages: AbstractIntlMessages = FOLIO_CATALOGS[uiLocale];

  const editor = useRef<DocxEditorRef>(null);
  // folio's fit over the width it fitted, read once, at the first paint,
  // before any zoom of the person's.
  const [fitPerPixel, setFitPerPixel] = useState<number | null>(null);
  const [width, setWidth] = useState(
    () => document.documentElement.clientWidth,
  );
  const zoomed = useRef(false);

  const painted = useEffectEvent(() => {
    const fitted = editor.current?.getZoom();
    if (fitted !== undefined) {
      setFitPerPixel(
        (current) => current ?? fitted / document.documentElement.clientWidth,
      );
    }
    onReady();
  });

  useEffect(() => {
    const resized = () => {
      setWidth(document.documentElement.clientWidth);
    };
    window.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("resize", resized);
    };
  }, []);

  useEffect(() => {
    const target = docxZoomTarget({
      fitPerPixel,
      width,
      zoom,
      zoomed: zoomed.current,
    });
    if (target === null) {
      return;
    }
    zoomed.current = true;
    editor.current?.setZoom(target);
  }, [fitPerPixel, width, zoom]);

  useEffect(() => {
    declareFolioFonts();
    // folio paints the first page once it has laid the document out.
    const observer = new MutationObserver(() => {
      if (document.querySelector(".layout-page") !== null) {
        observer.disconnect();
        requestAnimationFrame(() => {
          painted();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <IntlProvider locale={uiLocale} messages={messages}>
      <DocxEditor
        autoOpenReviewSidebar={false}
        className="h-full"
        documentBuffer={bytes}
        enableWheelZoom={false}
        initialZoom="fit-width"
        mode="viewing"
        onError={(error: Error) => {
          onFailed(error.message);
        }}
        readOnly
        ref={editor}
        showHeaderFooterEditing={false}
        showPrintButton={false}
        showReviewControls={false}
        showToolbar={false}
        showZoomControl={false}
      />
    </IntlProvider>
  );
};
