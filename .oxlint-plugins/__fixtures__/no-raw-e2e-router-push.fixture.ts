// Passive regression fixture for
// `no-raw-e2e-router-push/no-raw-e2e-router-push`.

declare const page: {
  evaluate: (run: (path: string) => void, path: string) => Promise<void>;
};
declare const openMemberDecision: (path: string) => Promise<void>;

export const openDecisionDirectly = async (): Promise<void> => {
  // MUST flag: the spec could read the gated fallback reader.
  // oxlint-disable-next-line no-raw-e2e-router-push/no-raw-e2e-router-push -- fixture: a raw push skips the wait for the reader that stays
  await page.evaluate((path) => history.pushState(null, "", path), "/law");
};

export const openDecisionThroughHelper = async (): Promise<void> => {
  // expect-clean: no-raw-e2e-router-push/no-raw-e2e-router-push
  await openMemberDecision("/law");
};
