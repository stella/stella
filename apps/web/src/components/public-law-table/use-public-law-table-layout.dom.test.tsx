import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";
import { DEFAULT_STATUTE_TABLE_LAYOUT } from "@/features/statutes/statute-table-layout.logic";
import {
  decisionLayoutsCookieSchema,
  defaultPresentationPrefs,
  serializeTableLayoutCookie,
  statuteLayoutsCookieSchema,
} from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { createPresentationPrefsSync } from "@/lib/account/presentation-prefs/sync";
import { createPrefsWriteLock } from "@/lib/account/presentation-prefs/sync.test-fixtures";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { PresentationPrefsProvider } =
  await import("@/lib/account/presentation-prefs/provider");
const { publicLawTableLayoutStore, usePublicLawTableLayout } =
  await import("./use-public-law-table-layout");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

test.each([
  { preference: "decisionLayouts", defaults: DEFAULT_DECISION_TABLE_LAYOUT },
  { preference: "statuteLayouts", defaults: DEFAULT_STATUTE_TABLE_LAYOUT },
] as const)(
  "$preference keeps overlapping CZE and POL edits after reload without peer messages",
  async ({ preference, defaults }) => {
    let cookie = defaultPresentationPrefs;
    const withLock = createPrefsWriteLock();
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const finished = Promise.withResolvers<undefined>();
    const store = publicLawTableLayoutStore(preference, defaults);
    const schema =
      preference === "decisionLayouts"
        ? decisionLayoutsCookieSchema
        : statuteLayoutsCookieSchema;
    const Surface = ({ country }: { country: string }) => {
      const { layout, setLayout } = usePublicLawTableLayout(store, country);
      return (
        <button
          type="button"
          aria-pressed={layout.contentMode === "fit-content"}
          onClick={() =>
            setLayout((latest) => ({ ...latest, contentMode: "fit-content" }))
          }
        >
          {country}
        </button>
      );
    };
    const createTab = () =>
      createPresentationPrefsSync({
        initialPrefs: cookie,
        read: async () => await Promise.resolve(cookie),
        withLock,
        // Deliberately omit BroadcastChannel: persistence cannot depend on
        // receiving another tab's notification before preparing the patch.
        write: async (patch: Partial<PresentationPrefs>) => {
          const incoming = cookie;
          if (
            patch[preference]?.["CZE"] !== undefined &&
            patch[preference]["POL"] === undefined
          ) {
            started.resolve(undefined);
            await release.promise;
          }
          const layouts = patch[preference];
          cookie = {
            ...incoming,
            ...patch,
            ...(layouts === undefined
              ? {}
              : {
                  [preference]: JSON.parse(
                    serializeTableLayoutCookie(layouts, schema),
                  ),
                }),
          };
          if (patch[preference]?.["POL"] !== undefined) {
            finished.resolve(undefined);
          }
          return cookie;
        },
      });
    const first = createTab();
    const second = createTab();
    const view = render(
      <>
        <PresentationPrefsProvider initialPrefs={cookie} sync={first}>
          <Surface country="cze" />
        </PresentationPrefsProvider>
        <PresentationPrefsProvider initialPrefs={cookie} sync={second}>
          <Surface country="pol" />
        </PresentationPrefsProvider>
      </>,
    );
    try {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "cze" }));
        await started.promise;
        fireEvent.click(view.getByRole("button", { name: "pol" }));
        release.resolve(undefined);
        await finished.promise;
      });
      expect(cookie[preference]).toMatchObject({
        CZE: { contentMode: "fit-content" },
        POL: { contentMode: "fit-content" },
      });
      view.unmount();
      const reload = render(
        <PresentationPrefsProvider initialPrefs={cookie} sync={createTab()}>
          <Surface country="cze" />
          <Surface country="pol" />
        </PresentationPrefsProvider>,
      );
      for (const country of ["cze", "pol"]) {
        expect(
          reload
            .getByRole("button", { name: country })
            .getAttribute("aria-pressed"),
        ).toBe("true");
      }
    } finally {
      release.resolve(undefined);
    }
  },
);
