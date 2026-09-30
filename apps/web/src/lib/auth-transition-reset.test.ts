import { isCancelledError, QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { publicKnowledgeKeys } from "@/features/knowledge/public/public-knowledge-queries";
import { rootKeys } from "@/lib/auth-queries";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import {
  installSessionCacheGuard,
  resetAuthTransition,
  settleAuthTransition,
} from "@/lib/session-cache-guard";

const sessionFor = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { userId, activeOrganizationId: organizationId },
});

const installGuard = (queryClient: QueryClient, isAuthFlowPage: boolean) => {
  const reloads: string[] = [];
  const uninstall = installSessionCacheGuard(queryClient, {
    isAuthFlowPage: () => isAuthFlowPage,
    reloadDocument: () => reloads.push("current"),
    reloadDocumentAt: (href) => reloads.push(href),
  });
  return { reloads, uninstall };
};

const catalogueKey = publicKnowledgeKeys.templates.catalogue();
const chatKey = ["threads", "member-a", "org-a"];
const memberKey = knowledgeKeys.templates.all("org-a");

describe("auth transition cache policy", () => {
  test("anonymous auth steps cancel pending reads and retain declared survivors", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(rootKeys.session, sessionFor("member-a", "org-a"));
    const { reloads, uninstall } = installGuard(queryClient, true);
    const heldKey = knowledgeKeys.playbooks.all("org-a");
    const response = Promise.withResolvers<string>();
    let aborted = false;
    const read = queryClient
      .query({
        queryKey: heldKey,
        queryFn: ({ signal }) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return response.promise;
        },
      })
      .catch((error: unknown) => error);
    try {
      queryClient.setQueryData(memberKey, "templates");
      queryClient.setQueryData(chatKey, "chat");
      queryClient.setQueryData(catalogueKey, "catalogue");
      expect(queryClient.getQueryState(heldKey)?.fetchStatus).toBe("fetching");

      queryClient.setQueryData(rootKeys.session, null);
      await settleAuthTransition(queryClient);
      expect(aborted).toBe(true);
      expect(isCancelledError(await read)).toBe(true);
      response.resolve("late playbooks");
      await response.promise;
      expect(queryClient.getQueryState(memberKey)).toBeUndefined();
      expect(queryClient.getQueryState(heldKey)).toBeUndefined();
      expect(queryClient.getQueryState(chatKey)?.data).toBe("chat");
      expect(queryClient.getQueryState(catalogueKey)?.data).toBe("catalogue");

      queryClient.setQueryData(
        rootKeys.session,
        sessionFor("member-a", "org-a"),
      );
      await settleAuthTransition(queryClient);
      await resetAuthTransition(queryClient, "member:member-a:org-a");
      expect(queryClient.getQueryState(chatKey)?.data).toBe("chat");
      expect(queryClient.getQueryState(memberKey)).toBeUndefined();
      expect(queryClient.getQueryState(catalogueKey)?.data).toBe("catalogue");
      expect(reloads).toEqual([]);
    } finally {
      response.resolve("cleanup");
      uninstall();
      queryClient.clear();
    }
  });

  test("anonymous auth steps remember the organization for the next member session", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(rootKeys.session, sessionFor("member-a", "org-a"));
    const { reloads, uninstall } = installGuard(queryClient, true);
    try {
      queryClient.setQueryData(chatKey, "chat");
      queryClient.setQueryData(catalogueKey, "catalogue");
      queryClient.setQueryData(rootKeys.session, null);
      await settleAuthTransition(queryClient);
      expect(queryClient.getQueryState(chatKey)?.data).toBe("chat");

      queryClient.setQueryData(
        rootKeys.session,
        sessionFor("member-a", "org-b"),
      );
      await settleAuthTransition(queryClient);
      await resetAuthTransition(queryClient, "member:member-a:org-b");
      expect(queryClient.getQueryState(chatKey)).toBeUndefined();
      expect(queryClient.getQueryState(catalogueKey)?.data).toBe("catalogue");
      expect(reloads).toEqual([]);
    } finally {
      uninstall();
      queryClient.clear();
    }
  });

  test("initial population retains declared prefixes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(rootKeys.session, null);
    const { reloads, uninstall } = installGuard(queryClient, true);
    const sessionChild = [...rootKeys.session, "detail"];
    const roleChild = [...rootKeys.role, "detail"];
    try {
      queryClient.setQueryData(sessionChild, "session detail");
      queryClient.setQueryData(rootKeys.role, "owner");
      queryClient.setQueryData(roleChild, "role detail");
      queryClient.setQueryData(catalogueKey, "catalogue");
      queryClient.setQueryData(memberKey, "templates");
      queryClient.setQueryData(
        rootKeys.session,
        sessionFor("member-a", "org-a"),
      );
      await settleAuthTransition(queryClient);
      await resetAuthTransition(queryClient, "member:member-a:org-a");
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toEqual([
        rootKeys.session,
        sessionChild,
        rootKeys.role,
        roleChild,
        catalogueKey,
      ]);
      expect(reloads).toEqual([]);
    } finally {
      uninstall();
      queryClient.clear();
    }
  });

  test("completed anonymous frames retain transition identity", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(rootKeys.session, sessionFor("member-a", "org-a"));
    const { reloads, uninstall } = installGuard(queryClient, false);
    try {
      queryClient.setQueryData(catalogueKey, "catalogue");
      queryClient.setQueryData(rootKeys.session, null);
      await settleAuthTransition(queryClient);
      await resetAuthTransition(queryClient, "anonymous");
      queryClient.setQueryData(rootKeys.role, "owner");
      queryClient.setQueryData(
        rootKeys.session,
        sessionFor("member-b", "org-b"),
      );
      await settleAuthTransition(queryClient);
      await resetAuthTransition(queryClient, "member:member-b:org-b");
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toEqual([rootKeys.session, catalogueKey]);
      expect(reloads).toEqual(["current"]);
    } finally {
      uninstall();
      queryClient.clear();
    }
  });

  const transitions = [
    {
      name: "organization change",
      next: sessionFor("member-a", "org-b"),
      visitor: "member:member-a:org-b",
      keepPrefixes: true,
      reloads: [],
    },
    {
      name: "member change",
      next: sessionFor("member-b", "org-a"),
      visitor: "member:member-b:org-a",
      keepPrefixes: false,
      reloads: ["current"],
    },
    {
      name: "sign-out",
      next: null,
      visitor: "anonymous",
      keepPrefixes: false,
      reloads: [],
    },
  ];

  for (const transition of transitions) {
    test(`seeded clients retain the declared survivors after ${transition.name}`, async () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(
        rootKeys.session,
        sessionFor("member-a", "org-a"),
      );
      queryClient.setQueryData(memberKey, "templates");
      const { reloads, uninstall } = installGuard(queryClient, false);
      const sessionChild = [...rootKeys.session, "detail"];
      const roleChild = [...rootKeys.role, "detail"];
      try {
        queryClient.setQueryData(sessionChild, "session detail");
        queryClient.setQueryData(rootKeys.role, "owner");
        queryClient.setQueryData(roleChild, "role detail");
        queryClient.setQueryData(chatKey, "chat");
        queryClient.setQueryData(catalogueKey, "catalogue");
        queryClient.setQueryData(rootKeys.session, transition.next);
        await settleAuthTransition(queryClient);
        expect(queryClient.getQueryState(memberKey)).toBeUndefined();
        await resetAuthTransition(queryClient, transition.visitor);

        const survivors = queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey);
        expect(survivors).toEqual(
          transition.keepPrefixes
            ? [
                rootKeys.session,
                sessionChild,
                rootKeys.role,
                roleChild,
                catalogueKey,
              ]
            : [rootKeys.session, catalogueKey],
        );
        expect(queryClient.getQueryState(rootKeys.session)?.data).toEqual(
          transition.next,
        );
        expect(reloads).toEqual(transition.reloads);
      } finally {
        uninstall();
        queryClient.clear();
      }
    });
  }
});
