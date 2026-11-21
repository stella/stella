import { expect, test } from "bun:test";

import { openDecisionAnchor, openProvisionAnchor } from "./link-actions";
import type { ReaderPager } from "./model";

const citation = {
  pieceId: "block48",
  start: 0,
  end: 10,
  citationId: "reference1",
  decisionId: "decision2",
  url: "https://stella.example/law/cze/cases/constitutional/id--decision2",
} satisfies ReaderPager["citationAnchors"][number];
const provision = {
  pieceId: "block48",
  start: 11,
  end: 20,
  provision: { document_id: "document1", anchor: "par_1" },
  url: "https://stella.example/law/cze/statutes/id--document1#par_1",
} satisfies ReaderPager["provisionAnchors"][number];

for (const supportsTools of [true, false]) {
  test(`reader links use ${supportsTools ? "host tools" : "canonical web links"}`, async () => {
    const actions: unknown[] = [];
    const host = {
      supportsTools: () => supportsTools,
      openLink: async (url: string) => {
        actions.push({ url });
      },
      openDecision: async (decisionId: string) => {
        actions.push({ decisionId });
      },
      previewProvision: async (ref: typeof provision.provision) => {
        actions.push({ provision: ref });
      },
    };
    await openDecisionAnchor(citation, host);
    await openProvisionAnchor(provision, host);
    expect(actions).toEqual(
      supportsTools
        ? [
            { decisionId: citation.decisionId },
            { provision: provision.provision },
          ]
        : [{ url: citation.url }, { url: provision.url }],
    );
    actions.length = 0;
    await openDecisionAnchor({ ...citation, url: null }, host);
    await openProvisionAnchor({ ...provision, url: null }, host);
    expect(actions).toEqual(
      supportsTools
        ? [
            { decisionId: citation.decisionId },
            { provision: provision.provision },
          ]
        : [],
    );
  });
}
