import "@stll/folio-react/standalone.css";
import { useEffect, useState } from "react";

import { IntlProvider } from "use-intl";

import { DocxEditor } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";

// A real Word .docx (Y Combinator's post-money SAFE, published free to use) so
// the hero opens on a genuine, richly-formatted legal document rather than a
// markdown approximation — folio loads it through its `documentBuffer` path,
// preserving the original Word formatting. Served from public/samples.
const SAMPLE_DOCX_URL = "/samples/safe.docx";

// folio's own canonical English strings for the "folio" namespace its
// toolbar/dialogs read via `useTranslations("folio")` (from
// @stll/folio-core/i18n/messages) — always in sync with the installed folio
// version, not a hand-copied catalog. The landing has no i18n runtime wired to
// its React islands, so this demo stays English-only.
const FOLIO_MESSAGES = getFolioMessages("en");

/**
 * Live, in-browser run of stella's real DOCX editor (folio) as the editor
 * product page's hero: a real .docx (a SAFE) is fetched and opened client-side
 * and is fully editable — including folio's own formatting toolbar and
 * track-changes toggle — with no server round-trip.
 *
 * Mounted with Astro's `client:only="react"` (see ProductMediaFrame.astro),
 * not `client:visible`: folio's `DocxEditor` renders a real ProseMirror surface
 * and has no server snapshot, so `astro build`'s SSR of a `client:visible`
 * island crashes (its `useEditorMode` calls `useSyncExternalStore` without the
 * `getServerSnapshot` argument SSR requires). `client:only` skips server
 * rendering, which is also simply correct for a ProseMirror-backed editor.
 *
 * `DocxEditor` ships its own dependency-light default chrome (buttons, menus,
 * dialogs, keyed off the same `--doc-*` CSS variables the app's semantic tokens
 * define) when no `components` override is supplied, so this stays
 * self-contained — no design-system wiring required to prove the engine mounts
 * and edits.
 */
export const EditorLiveDemo = () => {
  const [documentBuffer, setDocumentBuffer] = useState<ArrayBuffer | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(SAMPLE_DOCX_URL, {
          signal: AbortSignal.timeout(10_000),
        });
        const buffer = await response.arrayBuffer();
        if (!cancelled) {
          setDocumentBuffer(buffer);
        }
      } catch {
        // Demo hero: on failure the loading state stays; nothing to surface.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <IntlProvider
      locale="en"
      // SAFETY: `messages` is typed against the landing site's own generated
      // `Messages` catalog (src/types/i18n.d.ts's `AppConfig` augmentation).
      // `FOLIO_MESSAGES` is folio's own, structurally unrelated "folio"
      // namespace for this isolated island's `IntlProvider` scope, not the
      // app's catalog — same reasoning apps/web/src/i18n/formatting-context.test.tsx
      // uses for the same mismatch.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      messages={FOLIO_MESSAGES as never}
    >
      <div
        className="h-full w-full"
        style={{ background: "var(--background)" }}
      >
        {documentBuffer ? (
          <DocxEditor
            className="folio-docx-preview h-full"
            documentBuffer={documentBuffer}
            documentKey="editor-live-demo"
            // Fit the page to the embed width so the SAFE never overflows and
            // clips on the right; folio re-fits as the hero frame resizes.
            initialZoom="fit-width"
            // folio's document-outline rail defaults on and is designed for a
            // wide editor (it's an absolutely-positioned right overlay); in this
            // compact hero embed it would overlap the page, so opt out via
            // folio's public prop. Intended configuration, not a workaround.
            showOutline={false}
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-sm"
            style={{ color: "var(--muted-foreground)" }}
          >
            Loading the editor…
          </div>
        )}
      </div>
    </IntlProvider>
  );
};
