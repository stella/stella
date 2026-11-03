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

/** How long typing pauses before the edits are saved. */
const SAVE_PAUSE_MS = 1500;

/**
 * A Word document laid out in pages by folio, as the web shows it, `zoom`
 * times the width folio fits the page to. As on the web there is no edit
 * button: read-only, a tap into the text asks for editing (`onEditRequest`);
 * once `editable`, folio edits in place and the edits are saved after each
 * pause in typing, and at once when `saveRequest` changes, which is final.
 */
export const DocxPages = ({
  bytes,
  locale,
  zoom,
  editable,
  saveRequest,
  onEditRequest,
  onSaved,
  onReady,
  onFailed,
}: {
  bytes: Uint8Array;
  locale: string;
  /** The page's width as a factor of folio's fit (see ./zoom.ts). */
  zoom: number;
  /** The app holds the document's edit lock, so folio edits. */
  editable: boolean;
  /** Changes to ask for the edits now; such a save ends the editing. */
  saveRequest: number;
  onEditRequest: () => void;
  /**
   * One save: the whole document, or null when nothing changed since the
   * last save. The next save waits for this one. Whether it was stored comes
   * back; edits that were not stay for the next save.
   */
  onSaved: (bytes: Uint8Array | null, final: boolean) => Promise<boolean>;
  onReady: () => void;
  onFailed: (message: string) => void;
}) => {
  const [uiLocale] = useState(() => resolveUiLocale(locale) ?? "en");
  // folio's own catalogue, not the app's: this provider serves folio alone.
  const messages: AbstractIntlMessages = FOLIO_CATALOGS[uiLocale];

  const editor = useRef<DocxEditorRef>(null);
  // Edits not yet handed to `onSaved`, and the save in flight.
  const dirty = useRef(false);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveOnce = async (final: boolean) => {
    if (!dirty.current) {
      await onSaved(null, final);
      return;
    }
    dirty.current = false;
    const buffer = await editor.current?.save();
    if (buffer === null || buffer === undefined) {
      dirty.current = true;
      await onSaved(null, final);
      return;
    }
    if (!(await onSaved(new Uint8Array(buffer), final))) {
      dirty.current = true;
    }
  };

  // Saves wait for one another; a failed one leaves the edits to the next.
  const save = (final: boolean) => {
    if (pause.current !== null) {
      clearTimeout(pause.current);
      pause.current = null;
    }
    saving.current = saving.current
      .then(async () => await saveOnce(final))
      .catch((error: unknown) => {
        dirty.current = true;
        onFailed(String(error));
      });
  };
  const saveAsked = useEffectEvent(() => {
    save(true);
  });

  const changed = () => {
    dirty.current = true;
    if (pause.current !== null) {
      clearTimeout(pause.current);
    }
    pause.current = setTimeout(() => {
      pause.current = null;
      save(false);
    }, SAVE_PAUSE_MS);
  };

  const askedToSave = useRef(saveRequest);
  useEffect(() => {
    if (saveRequest !== askedToSave.current) {
      askedToSave.current = saveRequest;
      saveAsked();
    }
  }, [saveRequest]);

  useEffect(
    () => () => {
      if (pause.current !== null) {
        clearTimeout(pause.current);
      }
    },
    [],
  );
  // folio's fit over the width it fitted, read once, while folio still
  // fits the page itself: at the first paint, or else at the first zoom.
  const fitPerPixel = useRef<number | null>(null);
  const [width, setWidth] = useState(
    () => document.documentElement.clientWidth,
  );
  const zoomed = useRef(false);

  const readFit = () => {
    const fitted = editor.current?.getZoom();
    if (
      fitPerPixel.current === null &&
      !zoomed.current &&
      fitted !== undefined
    ) {
      fitPerPixel.current = fitted / document.documentElement.clientWidth;
    }
  };

  const painted = useEffectEvent(() => {
    readFit();
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

  const applyZoom = useEffectEvent((atWidth: number, atZoom: number) => {
    readFit();
    const target = docxZoomTarget({
      fitPerPixel: fitPerPixel.current,
      width: atWidth,
      zoom: atZoom,
      zoomed: zoomed.current,
    });
    if (target === null) {
      return;
    }
    zoomed.current = true;
    editor.current?.setZoom(target);
  });

  useEffect(() => {
    applyZoom(width, zoom);
  }, [width, zoom]);

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
      <div
        className="h-full"
        // A tap into the read-only text asks for editing, as a click does on
        // the web; a scroll does not end in a click.
        onClickCapture={editable ? undefined : onEditRequest}
      >
        <DocxEditor
          autoOpenReviewSidebar={false}
          className="h-full"
          documentBuffer={bytes}
          enableWheelZoom={false}
          initialZoom="fit-width"
          mode={editable ? "editing" : "viewing"}
          onError={(error: Error) => {
            onFailed(error.message);
          }}
          {...(editable ? { onChange: changed } : {})}
          onReadonlyEditAttempt={onEditRequest}
          readOnly={!editable}
          ref={editor}
          showHeaderFooterEditing={false}
          showPrintButton={false}
          showReviewControls={false}
          showToolbar={false}
          showZoomControl={false}
        />
      </div>
    </IntlProvider>
  );
};
