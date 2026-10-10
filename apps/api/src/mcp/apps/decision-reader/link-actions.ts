import type { ReaderPager } from "./model";

type ReaderLinkHost = {
  supportsTools: () => boolean;
  openLink: (url: string) => Promise<void>;
  openDecision: (decisionId: string) => Promise<void>;
  previewProvision: (
    provision: ReaderPager["provisionAnchors"][number]["provision"],
  ) => Promise<void>;
};
export const openDecisionAnchor = async (
  anchor: ReaderPager["citationAnchors"][number],
  host: ReaderLinkHost,
) => {
  if (host.supportsTools()) {
    await host.openDecision(anchor.decisionId);
    return;
  }
  if (anchor.appUrl !== null) {
    await host.openLink(anchor.appUrl);
  }
};
export const openProvisionAnchor = async (
  anchor: ReaderPager["provisionAnchors"][number],
  host: ReaderLinkHost,
) => {
  if (host.supportsTools()) {
    await host.previewProvision(anchor.provision);
    return;
  }
  if (anchor.appUrl !== null) {
    await host.openLink(anchor.appUrl);
  }
};
