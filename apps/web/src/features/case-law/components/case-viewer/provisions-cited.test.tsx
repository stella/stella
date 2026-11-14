import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  PROVISION_LINK_CAPABILITIES,
  type ProvisionLinkCapability,
  provisionLinkCapability,
} from "@stll/api-contract/provision-link-capability";
import {
  PROVISION_LINK_STATUS_TYPES,
  type ProvisionLinkStatus,
} from "@stll/api-contract/provision-link-status";

import { ProvisionsCited } from "@/features/case-law/components/case-viewer/provisions-cited";
import { decisionProvisionsInfiniteOptions } from "@/features/case-law/queries/provisions";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

import { provision } from "./provisions-cited.fixture";

const decisionId: SafeId<"caseLawDecision"> = toSafeId<"caseLawDecision">(
  "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
);

const renderPanel = (children: ReactNode, queryClient: QueryClient) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

const seed = (
  items: ReturnType<typeof provision>[],
  status?: ProvisionLinkStatus,
  capability?: ProvisionLinkCapability,
) => {
  const queryClient = new QueryClient();

  queryClient.setQueryData(
    decisionProvisionsInfiniteOptions(decisionId).queryKey,
    {
      pageParams: [null],
      pages: [
        {
          items,
          limit: 50,
          nextCursor: null,
          previews: [],
          status: status ?? { type: "legacy" },
          generation: "0",
          publishedProjectionDigest: null,
          capability:
            capability?.type === "supported"
              ? { type: capability.type, languages: [...capability.languages] }
              : (capability ?? { type: "supported", languages: ["cs"] }),
          pendingSince: null,
        },
      ],
    },
  );

  return queryClient;
};

describe("ProvisionsCited", () => {
  test.each(PROVISION_LINK_STATUS_TYPES)(
    "keeps an empty %s result explicit",
    (type) => {
      const markup = renderPanel(
        <ProvisionsCited
          decisionDate="2024-01-01"
          decisionId={decisionId}
          isHydrated
          expanded
        />,
        seed([], { type }),
      );
      expect(markup).toContain(messages.caseLaw.viewer.provisionsCited);
      expect(markup).toContain('role="status"');
      expect(markup.includes(messages.caseLaw.viewer.provisionsNoneFound)).toBe(
        type === "current",
      );
      if (["pending", "stale", "legacy"].includes(type)) {
        expect(markup).toContain(messages.caseLaw.viewer.provisionsProcessing);
      }
      if (type === "failed") {
        expect(markup).toContain(messages.caseLaw.viewer.provisionsFailed);
      }
    },
  );

  test("names the panel, and states the references only once opened", () => {
    const markup = renderPanel(
      <ProvisionsCited
        decisionDate="2024-01-01"
        decisionId={decisionId}
        isHydrated
      />,
      seed([provision({})]),
    );

    expect(markup).toContain(messages.caseLaw.viewer.provisionsCited);
    // Closed is the resting state: the references are a reading aid beside
    // the decision, and opening them is what resolves each cited work.
    expect(markup).not.toContain("§ 265b");
    expect(markup).toContain('aria-expanded="false"');
  });
});

const expectedStatusMessages = {
  current: messages.caseLaw.viewer.provisionsNoneFound,
  failed: messages.caseLaw.viewer.provisionsFailed,
  legacy: messages.caseLaw.viewer.provisionsProcessing,
  out_of_scope: messages.caseLaw.viewer.provisionsUnsupported,
  pending: messages.caseLaw.viewer.provisionsProcessing,
  stale: messages.caseLaw.viewer.provisionsProcessing,
  unavailable: messages.caseLaw.viewer.provisionsUnavailable,
  unplaceable: messages.caseLaw.viewer.provisionsUnplaceable,
  withheld: messages.caseLaw.viewer.provisionsWithheld,
} satisfies Record<ProvisionLinkStatus["type"], string>;

const capabilities = [
  ...Object.entries(PROVISION_LINK_CAPABILITIES).map(([name, capability]) => ({
    name,
    capability,
  })),
  {
    name: "unsupported language",
    capability: provisionLinkCapability("CZE", "en"),
  },
  {
    name: "unknown jurisdiction",
    capability: provisionLinkCapability("unknown", "en"),
  },
];
const statusCases = capabilities.flatMap(({ name, capability }) =>
  PROVISION_LINK_STATUS_TYPES.flatMap((type) =>
    [0, 1].map((count) => ({ name, capability, type, count })),
  ),
);

test.each(statusCases)(
  "rendered capability $name with $type and $count rows",
  ({ capability, type, count }) => {
    const markup = renderPanel(
      <ProvisionsCited
        decisionDate="2024-01-01"
        decisionId={decisionId}
        isHydrated
        expanded
      />,
      seed(count === 0 ? [] : [provision({})], { type }, capability),
    );
    const unsupported = capability.type === "notSupportedYet";
    if (type === "current" && count > 0 && !unsupported) {
      expect(markup).not.toContain('role="status"');
    } else {
      const expected = unsupported
        ? messages.caseLaw.viewer.provisionsUnsupported
        : expectedStatusMessages[type];
      expect(markup).toContain(expected);
      expect(markup).toContain('role="status"');
    }
    if (unsupported) {
      expect(markup).not.toContain(
        messages.caseLaw.viewer.provisionsProcessing,
      );
      expect(markup).not.toContain(messages.caseLaw.viewer.provisionsNoneFound);
    }
  },
);

test("pending with unsupported capability shows unsupported disposition", () => {
  const markup = renderPanel(
    <ProvisionsCited
      decisionDate="2024-01-01"
      decisionId={decisionId}
      isHydrated
      expanded
    />,
    seed([], { type: "pending" }, provisionLinkCapability("USA", "en")),
  );
  expect(markup).toContain(messages.caseLaw.viewer.provisionsUnsupported);
  expect(markup).not.toContain(messages.caseLaw.viewer.provisionsProcessing);
});
