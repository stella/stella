import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type {
  KnowledgeActions,
  KnowledgeSource,
} from "@/features/knowledge/views/knowledge-seam";
import { PlaybooksPageView } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const noop = () => undefined;

const ACTIONS: KnowledgeActions<"playbooks"> = {
  open: noop,
  loadMore: noop,
  refresh: noop,
};

const STARTERS: KnowledgeSource<"playbooks">["starters"] = {
  status: "ready",
  items: [
    {
      starterId: "nda",
      name: "NDA",
      description: "Mutual NDA",
      positionCount: 12,
    },
  ],
  pendingStarterId: null,
};

const render = (
  source: KnowledgeSource<"playbooks">,
  actions: KnowledgeActions<"playbooks"> = ACTIONS,
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <PlaybooksPageView actions={actions} source={source} />
      </FormattingProvider>
    </IntlProvider>,
  );

describe("playbooks page", () => {
  test("shows the ready-made playbooks only where they can be started", () => {
    expect(render({ starters: STARTERS })).not.toContain("Mutual NDA");
    expect(
      render({ starters: STARTERS }, { ...ACTIONS, startFrom: noop }),
    ).toContain("Mutual NDA");
  });

  test("the build card shows only with its action", () => {
    const builder = { start: noop, status: "idle" } as const;
    expect(
      render(
        { starters: STARTERS },
        { ...ACTIONS, startFrom: noop, buildWithAi: builder },
      ),
    ).toContain("Build with AI");
    expect(
      render({ starters: STARTERS }, { ...ACTIONS, startFrom: noop }),
    ).not.toContain("Build with AI");
  });

  // Where there is no library there is nothing recent and no full list; the
  // page must not show their empty states as if the library were empty.
  test("shows no library sections without a library", () => {
    const html = render(
      { starters: STARTERS },
      { ...ACTIONS, startFrom: noop },
    );
    expect(html).not.toContain("Recently used");
    expect(html).not.toContain("All playbooks");
  });

  test("a playbook without a description or known edit time shows neither", () => {
    const html = render({
      starters: STARTERS,
      library: {
        playbooks: [
          { id: "p1", name: "NDA review", description: null, status: "draft" },
        ],
        hasNextPage: false,
        isFetchingNextPage: false,
      },
    });
    expect(html).toContain("NDA review");
    expect(html).not.toContain("Updated");
  });

  test("ready-made playbooks that could not be read say so, with a retry where there is one", () => {
    const failed = {
      status: "error",
      items: [],
      pendingStarterId: null,
    } as const;
    const withRetry = render(
      { starters: { ...failed, retry: noop } },
      { ...ACTIONS, startFrom: noop },
    );
    expect(withRetry).toContain("The catalogue is not available right now.");
    expect(withRetry).toContain("Retry");

    const withoutRetry = render(
      { starters: failed },
      { ...ACTIONS, startFrom: noop },
    );
    expect(withoutRetry).toContain("The catalogue is not available right now.");
    expect(withoutRetry).not.toContain("Retry");
  });
});
