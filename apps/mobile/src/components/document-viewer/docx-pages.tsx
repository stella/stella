import { useEffect, useEffectEvent, useState } from "react";

import { IntlProvider } from "use-intl";
import type { AbstractIntlMessages } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
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

import { FOLIO_FONT_FACES } from "./folio-fonts.gen";

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

/** Where Metro serves a bundled font file from, in a web bundle. */
const fontUrl = (source: unknown): string | null => {
  if (typeof source === "string") {
    return source;
  }
  if (
    typeof source === "object" &&
    source !== null &&
    "uri" in source &&
    typeof source.uri === "string"
  ) {
    return source.uri;
  }
  return null;
};

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
    const url = fontUrl(face.source);
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

/** A Word document laid out in pages by folio, read-only, as the web shows it. */
export const DocxPages = ({
  bytes,
  locale,
  onReady,
  onFailed,
}: {
  bytes: Uint8Array;
  locale: string;
  onReady: () => void;
  onFailed: (message: string) => void;
}) => {
  const [uiLocale] = useState(() => resolveUiLocale(locale) ?? "en");
  // folio's own catalogue, not the app's: this provider serves folio alone.
  const messages: AbstractIntlMessages = FOLIO_CATALOGS[uiLocale];

  const painted = useEffectEvent(() => {
    onReady();
  });

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
        showHeaderFooterEditing={false}
        showPrintButton={false}
        showReviewControls={false}
        showToolbar={false}
        showZoomControl={false}
      />
    </IntlProvider>
  );
};
