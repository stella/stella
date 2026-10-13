import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { GatedChatComposer } from "@/components/ai-suggestions/gated-chat-composer";
import {
  ACCOUNT_GATE_FOR_SESSION,
  ACCOUNT_GATE_OUTCOME,
} from "@/components/auth/require-account.logic";
import en from "@/i18n/langs/en.json";

const DECISION_HREF = "/law/cz/cases/ns/21-cdo-1234-2024";

const rootRoute = createRootRoute();

/**
 * Enough router for a static render: the gate reads the current href for its
 * return trip and navigates to `/auth` when no shell dialog is in reach.
 */
const TestRouter = ({ children }: { children: ReactNode }) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [DECISION_HREF] }),
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/auth" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/law/$country/cases/$court/$slug",
      }),
    ]),
  });

  return (
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  );
};

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <TestRouter>{node}</TestRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );

describe("account gate", () => {
  // The public shell mounts the authenticated-user provider only once the
  // session read resolves, so "no provider yet" and "no account" look alike.
  // A member who presses an AI control in that window must not be told to
  // create an account and lose the press.
  test("a session still being read is not a visitor", () => {
    expect(ACCOUNT_GATE_FOR_SESSION.checking).toBe(
      ACCOUNT_GATE_OUTCOME.checking,
    );
    expect(ACCOUNT_GATE_FOR_SESSION.authenticated).toBe(
      ACCOUNT_GATE_OUTCOME.allowed,
    );
    expect(
      Object.entries(ACCOUNT_GATE_FOR_SESSION)
        .filter(([, outcome]) => outcome === ACCOUNT_GATE_OUTCOME.asking)
        .map(([status]) => status),
    ).toEqual(["anonymous", "unavailable"]);
  });
});

describe("gated chat composer", () => {
  const renderOffer = () =>
    render(
      <GatedChatComposer
        activeLegal={{
          type: "decision",
          decisionId: "decision-1",
          caseNumber: "21 Cdo 1234/2024",
        }}
      />,
    );

  test("offers a visitor sign-in for the document, not a bar that cannot send", () => {
    const markup = renderOffer();

    expect(markup).toContain(en.chat.signInToChatAbout);
    expect(markup).toContain("21 Cdo 1234/2024");
    expect(markup).toContain(en.auth.signIn);
    // Neither half of the member's bar: no attachment menu, no send.
    expect(markup).not.toContain("lucide-plus");
    expect(markup).not.toContain("lucide-arrow-up");
  });

  test("keeps the offer visible to assistive tech", () => {
    const markup = renderOffer();

    // The loading shell hides itself; the way in must not.
    const offerTag = /<div[^>]*data-slot="gated-chat-sign-in"[^>]*>/u.exec(
      markup,
    )?.[0];
    expect(offerTag).toBeDefined();
    expect(offerTag).not.toContain("aria-hidden");
  });
});
