import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/knowledge" });

const testing = await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { act } = await import("react");
const { PendingCacheScope } = await import("@/components/pending-cache");
const { env } = await import("@/env");
const { rootKeys } = await import("@/lib/account/auth-query-keys.logic");
const { memberLandingSections } =
  await import("@/lib/knowledge/landing-sections.logic");
const { useConfigStore } = await import("@/stores/config-store");
const { KnowledgeLandingPending } =
  await import("@/routes/knowledge/-knowledge-landing.pending");

const initialKept = useConfigStore.getState().knowledgeLanding;

afterEach(() => {
  testing.cleanup();
  useConfigStore.setState({ knowledgeLanding: initialKept });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const cardSections = (root: ParentNode) =>
  [
    ...root.querySelectorAll('[data-slot="knowledge-section-card-pending"]'),
  ].map((card) =>
    card instanceof HTMLElement ? card.dataset["section"] : null,
  );

/** A member's cache: their session, and the role read when one has
 *  settled, as the protected shell leaves them. */
const memberCache = (role?: string) => {
  const cache = new QueryClient();
  cache.setQueryData(rootKeys.session, { user: { id: "member" } });
  if (role !== undefined) {
    cache.setQueryData(rootKeys.role, role);
  }
  return cache;
};

test("the landing draws the sections this browser's landing last showed, in the landing's order", () => {
  // Kept out of order: the cards follow the landing, not the stored list.
  useConfigStore.setState({ knowledgeLanding: ["clauses", "tools"] });
  const { container } = testing.render(
    <PendingCacheScope client={memberCache()}>
      <KnowledgeLandingPending />
    </PendingCacheScope>,
  );
  expect(cardSections(container)).toEqual(["tools", "clauses"]);
});

test("with nothing kept, the cached role decides whether house styles show", () => {
  useConfigStore.setState({ knowledgeLanding: null });
  const sectionsFor = (role: string) => {
    const { container, unmount } = testing.render(
      <PendingCacheScope client={memberCache(role)}>
        <KnowledgeLandingPending />
      </PendingCacheScope>,
    );
    const sections = cardSections(container);
    unmount();
    return sections;
  };
  expect(sectionsFor("member")).toContain("styles");
  expect(sectionsFor("external")).not.toContain("styles");
  // The same sections the loaded landing derives for that role.
  expect(sectionsFor("member")).toEqual(
    memberLandingSections({
      styleSetsGranted: true,
      workflowsEnabled: env.VITE_WORKFLOWS_ENABLED,
    }).map((section) => section.key),
  );
});

test("a cold paint claims no cards, then hydrates to the kept ones without a mismatch", async () => {
  useConfigStore.setState({ knowledgeLanding: ["tools", "templates"] });
  const view = (
    <PendingCacheScope client={memberCache()}>
      <KnowledgeLandingPending />
    </PendingCacheScope>
  );
  const html = renderToString(view);
  const host = document.createElement("div");
  // safe-html: renderToString output of the pending view under test.
  host.innerHTML = html;
  // The server has no browser storage: its paint holds no card it could
  // later take back.
  expect(cardSections(host)).toEqual([]);

  const errors: unknown[] = [];
  document.body.append(host);
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(host, view, {
      onRecoverableError: (error) => {
        errors.push(error);
      },
    });
    await Promise.resolve();
  });
  expect(errors).toEqual([]);
  expect(cardSections(host)).toEqual(["tools", "templates"]);
  act(() => root?.unmount());
  host.remove();
});
