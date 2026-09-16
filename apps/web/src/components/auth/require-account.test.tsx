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
  ACCOUNT_INTENT_TITLE_KEYS,
} from "@/components/auth/require-account.logic";
import en from "@/i18n/langs/en.json";

const DECISION_HREF = "/law/cz/cases/ns/21-cdo-1234-2024";

const rootRoute = createRootRoute();

/**
 * Enough router for a static render: the gate reads the current href for its
 * return trip and links to `/auth` when no shell dialog is in reach.
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
  // Every gated act has to say what it is: an intent with no sentence, or one
  // reusing another's, leaves the visitor reading about something else. The
  // dialog itself is portalled, so there is no server markup to read this from.
  test("every intent leads with a sentence of its own", () => {
    const intents = Object.entries(ACCOUNT_INTENT_TITLE_KEYS);
    const sentences = intents.map(([intent, key]) => {
      const sentence: unknown = Reflect.get(en.auth.requireAccount, intent);

      // The catalog is reached through the intent's own name, so a renamed
      // intent takes its sentence with it instead of silently losing one.
      expect(key.startsWith("auth.requireAccount.")).toBe(true);
      expect(key.split(".").at(-1)).toBe(intent);
      expect(typeof sentence).toBe("string");
      return sentence;
    });

    expect(new Set(sentences).size).toBe(intents.length);
  });

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
    ).toEqual(["anonymous"]);
  });
});

describe("gated chat composer", () => {
  test("draws the member's bar, with the same copy, for a visitor", () => {
    const markup = render(
      <GatedChatComposer
        activeLegal={{
          type: "decision",
          decisionId: "decision-1",
          caseNumber: "21 Cdo 1234/2024",
        }}
      />,
    );

    // The same empty row a member reads, and the same owned pair of controls
    // the live bar carries.
    expect(markup).toContain(en.chat.sourcePlaceholderAction);
    expect(markup).toContain("21 Cdo 1234/2024");
    expect(markup).toContain("lucide-plus");
    expect(markup).toContain("lucide-arrow-up");
  });

  test("offers the whole bar as one target a screen reader can name", () => {
    const markup = render(
      <GatedChatComposer
        activeLegal={{
          type: "decision",
          decisionId: "decision-1",
          caseNumber: "21 Cdo 1234/2024",
        }}
      />,
    );

    // The loading shell hides itself from assistive tech; a bar that is the
    // way in must not, and it carries the editor's own sentence as its name.
    expect(markup).toContain('aria-label="Chat about 21 Cdo 1234/2024"');
  });
});
