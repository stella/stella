import { renderToStaticMarkup } from "react-dom/server";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { InspectorRailGroup } from "@/components/inspector/inspector-group-rail";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";

afterEach(() => {
  useInspectorTabsStore.setState(useInspectorTabsStore.getInitialState(), true);
});

describe("Inspector group disclosure", () => {
  for (const locale of ["en", "ar"] as const) {
    test(`${locale}: collapsing preserves the active document and exposes an accessible disclosure`, () => {
      const store = useInspectorTabsStore.getState();
      store.openTask({
        taskId: "deadline",
        workspaceId: "matter-1",
        label: "Filing deadline",
      });
      store.toggleGroupCollapsed("matter:matter-1");
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const render = () =>
        renderToStaticMarkup(
          <IntlProvider
            locale={locale}
            messages={locale === "ar" ? ar : en}
            timeZone="Europe/Prague"
          >
            <DirectionProvider direction={locale === "ar" ? "rtl" : "ltr"}>
              <QueryClientProvider client={queryClient}>
                <AuthenticatedUserProvider
                  user={{
                    id: "test-user",
                    activeOrganizationId: "test-org",
                    email: "inspector@example.test",
                    image: null,
                    name: "Test",
                    preferredName: null,
                    timezoneId: "Europe/Prague",
                    wordEditShortcut: null,
                  }}
                >
                  <InspectorRailGroup
                    activeId={useInspectorTabsStore.getState().activeId}
                    collapsed={useInspectorTabsStore
                      .getState()
                      .collapsedGroupIds.includes("matter:matter-1")}
                    group={{
                      id: "matter:matter-1",
                      type: "matter",
                      workspaceId: "matter-1",
                      name: "Novák",
                      color: "--option-blue",
                    }}
                    tabs={useInspectorTabsStore.getState().tabs}
                  >
                    <button type="button">
                      {useInspectorTabsStore.getState().tabs.at(0)?.label}
                    </button>
                  </InspectorRailGroup>
                </AuthenticatedUserProvider>
              </QueryClientProvider>
            </DirectionProvider>
          </IntlProvider>,
        );
      const collapsed = render();
      expect(collapsed).toContain('aria-expanded="false"');
      expect(collapsed).toContain("aria-controls=");
      expect(collapsed).toContain(
        locale === "ar"
          ? 'aria-label="توسيع Novák"'
          : 'aria-label="Expand Novák"',
      );
      expect(collapsed).toContain('hidden=""');
      expect(useInspectorTabsStore.getState().activeId).toBe("deadline");
      store.setActive("deadline");
      const expanded = render();
      expect(expanded).toContain('aria-expanded="true"');
      expect(expanded).toContain(
        locale === "ar"
          ? 'aria-label="طي Novák"'
          : 'aria-label="Collapse Novák"',
      );
      expect(expanded).not.toContain('hidden=""');
      expect(expanded).toContain("Filing deadline");
      queryClient.clear();
    });
  }
});
