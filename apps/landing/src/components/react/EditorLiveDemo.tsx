import "@stll/folio-react/editor.css";
import { IntlProvider } from "use-intl";

import { DocxEditor, fromMarkdown } from "@stll/folio-react";
import { getFolioMessages } from "@stll/folio-react/messages";

const SAMPLE_CONTRACT_MARKDOWN = `# Master Services Agreement

This Agreement is entered into between **Northstar Robotics, Inc.** ("Customer")
and **Meridian Precision Components GmbH** ("Supplier").

## 1. Services

The Supplier shall provide precision drive components in accordance with the
specifications set out in Annex 1.

## 2. Term and termination

This Agreement commences on the Effective Date and continues for an initial
term of twenty-four (24) months, renewing automatically for successive
twelve (12) month periods unless either party gives ninety (90) days'
written notice of non-renewal.

## 3. Limitation of liability

Each party's aggregate liability under this Agreement shall not exceed one
hundred percent (100%) of the fees paid in the twelve (12) months preceding
the claim.
`;

const sampleDocument = fromMarkdown(SAMPLE_CONTRACT_MARKDOWN);

// folio's own canonical English strings for the "folio" namespace its
// toolbar/dialogs read via `useTranslations("folio")` (see
// @stll/folio-core/i18n/messages) — always in sync with the installed
// folio-react version, so this isn't a hand-maintained copy. The landing
// site has no i18n runtime wired to its React islands, so this demo stays
// English-only rather than plumbing a second translation surface.
const FOLIO_MESSAGES = getFolioMessages("en");

/**
 * Live, in-browser run of stella's real DOCX editor (folio) as the editor
 * product page's hero: a sample contract opens pre-parsed (via
 * `fromMarkdown`, no server round-trip) and is fully editable — including
 * folio's own formatting toolbar and track-changes toggle — entirely
 * client-side.
 *
 * Mounted with Astro's `client:only="react"` (see ProductMediaFrame.astro),
 * not `client:visible`: folio's `DocxEditor` renders a real ProseMirror
 * surface from its very first render whenever a `document` is already
 * available (unlike the `documentBuffer` path, which starts in a "loading"
 * state deferred to an effect), and it has no guard against running outside
 * a browser. Astro still server-renders `client:visible` islands for the
 * initial paint, which crashes here (confirmed via `astro build`: folio's
 * `useEditorMode` hook calls `useSyncExternalStore` without the
 * `getServerSnapshot` argument React requires for SSR). `client:only`
 * skips server rendering entirely, which is also simply correct for a
 * ProseMirror-backed editor — it was never meant to run outside a browser.
 *
 * `DocxEditor` ships its own dependency-light default chrome (buttons,
 * menus, dialogs, all keyed off the same `--doc-*` CSS variables the app's
 * semantic tokens already define) when no `components` override is
 * supplied, so this stays self-contained — no design-system wiring
 * required to prove the engine mounts and edits.
 */
export const EditorLiveDemo = () => (
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
    <div className="h-full w-full" style={{ background: "var(--background)" }}>
      <DocxEditor
        className="folio-docx-preview h-full"
        document={sampleDocument}
        documentKey="editor-live-demo"
        initialZoom={1}
        // folio's document-outline rail defaults on and is designed for a
        // wide editor (it's an absolutely-positioned right overlay); in this
        // compact hero embed it would overlap the page, so opt out via folio's
        // public prop. This is intended configuration, not a workaround.
        showOutline={false}
      />
    </div>
  </IntlProvider>
);
