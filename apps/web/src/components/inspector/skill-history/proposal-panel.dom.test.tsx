import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

import type { SkillProposalStatus } from "./skill-history.logic";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ProposalActionBar } = await import("./proposal-panel");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const noop = () => undefined;

const decisionButtons = (status: SkillProposalStatus) => {
  const ui = render(
    <IntlProvider locale="en" messages={messages}>
      <ProposalActionBar
        canManage
        initialSummary=""
        isAuthor={false}
        isStale={false}
        onAccept={noop}
        onBack={noop}
        onDelete={noop}
        onReject={noop}
        onSubmitForReview={noop}
        onSummaryChange={noop}
        status={status}
      />
    </IntlProvider>,
  );
  return ui
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    .filter(
      (name) =>
        name === messages.common.accept ||
        name === messages.skillHistory.reject,
    );
};

test.each([
  { status: "draft", decisions: [] },
  { status: "proposed", decisions: ["Accept", "Reject"] },
  { status: "accepted", decisions: [] },
  { status: "rejected", decisions: [] },
] as const)(
  "a manager sees decisions $decisions on a $status proposal",
  ({ status, decisions }) => {
    expect(decisionButtons(status).toSorted()).toEqual([...decisions]);
  },
);
