/**
 * The cited-provision header at a range of widths, on a bench a test can
 * measure.
 *
 * The header is the shared peek header: one row that must never wrap and
 * never lose its actions, and that gives way in a fixed order as it narrows:
 * the act's title, then the date, then the provision label. Which part gives
 * way is layout, so it is measured in a browser rather than asserted in a
 * unit test. The label names several cited parts, the widest a paragraph's
 * card draws.
 */

import { ProvisionCardHeader } from "@stll/decision-reader/cited-provision";
import type { CitedProvisionTarget } from "@stll/decision-reader/reader-types";
import { PEEK_ACTION_PRESENCE } from "@stll/decision-reader/reference-peek";

import { WebReaderProvider } from "@/components/legal-reader/web-reader-provider";

const BENCH_LABEL = "§ 226 odst. 1, § 226 odst. 2, § 226 odst. 3";

const BENCH_DOCUMENT_ID = "01a02a37-1111-7111-8111-111111111111";

const BENCH_PROVISION = {
  document: {
    country: "cz",
    eli: "/eli/cz/sb/1963/99",
    id: BENCH_DOCUMENT_ID,
    slug: null,
    versionValidFrom: "2022-09-01",
  },
  payload: {
    anchorId: "par_226",
    documentId: BENCH_DOCUMENT_ID,
    eli: "/eli/cz/sb/1963/99",
    highlightAnchorId: "par_226-odst_1",
    jurisdiction: "CZE",
    provisionLabel: "§ 226 odst. 1",
    statuteTitle: "99/1963 Sb., Občanský soudní řád",
    versionCount: 1,
    versionValidFrom: "2022-09-01",
  },
  preview: null,
} satisfies CitedProvisionTarget;

/** From a card with room to spare down to one narrower than the label alone. */
const BENCH_WIDTHS = [720, 560, 440, 360, 300, 240, 180, 120] as const;

export const ProvisionHeaderPlayground = () => (
  <WebReaderProvider>
    <div className="flex flex-col gap-3">
      {BENCH_WIDTHS.map((width) => (
        <section
          className="bg-muted/30 border-border/50 rounded-lg border px-3 py-2"
          data-header-width={String(width)}
          data-playground-section="provision-header"
          key={width}
          style={{ width: `${String(width)}px` }}
        >
          <ProvisionCardHeader
            actionPresence={PEEK_ACTION_PRESENCE.always}
            label={BENCH_LABEL}
            provision={BENCH_PROVISION}
          />
        </section>
      ))}
    </div>
  </WebReaderProvider>
);
