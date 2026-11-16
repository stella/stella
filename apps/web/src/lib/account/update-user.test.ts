import {
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import type { QueryKey, QueryMeta } from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";
import { expect, spyOn, test } from "bun:test";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createUserUpdateMutation,
  updateUserResource,
} from "@/lib/account/update-user";
import { rootKeys } from "@/lib/auth-query-options";
import { APIError } from "@/lib/errors/api";
import { AuthClientError } from "@/lib/errors/auth";
import {
  installSessionCacheGuard,
  settleAuthTransition,
} from "@/lib/session-cache-guard";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { calendarTasksOptions } from "@/lib/workspaces/queries/calendar-tasks";
import { taskDetailOptions, taskKeys } from "@/lib/workspaces/queries/tasks";

const organizationId = "organization-a";
const userId = "user-a";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const sessionFor = (id: string, organization: string | null) => ({
  user: { id },
  session: { activeOrganizationId: organization },
});

const createReaders = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(rootKeys.session, sessionFor(userId, organizationId));
  let name = "Zulu";
  const read = async () => name;
  const unsubscribes: (() => void)[] = [];
  const observe = ({
    queryKey,
    meta,
  }: {
    queryKey: QueryKey;
    meta: QueryMeta;
  }) => {
    const observer = new QueryObserver(
      client,
      queryOptions({
        queryKey,
        meta,
        initialData: "Zulu",
        queryFn: read,
      }),
    );
    unsubscribes.push(observer.subscribe(() => undefined));
    return { queryKey, value: () => observer.getCurrentResult().data };
  };
  const detailOptions = taskDetailOptions({
    workspaceId,
    taskId,
    organizationId,
  });
  const detail = observe(detailOptions);
  const calendar = observe(
    calendarTasksOptions(
      {
        workspaceId,
        dateFrom: "2026-11-01",
        dateTo: "2026-11-30",
        datePropertyIds: ["_due-date"],
        filters: [],
        sorts: [],
      },
      organizationId,
    ),
  );
  const foreignOrganization = observe(
    resourceQueryOptions(
      queryOptions({
        queryKey: [
          ...taskKeys.detail(workspaceId, taskId),
          "foreign-organization",
        ],
      }),
      {
        resources: [RESOURCE_TYPE.ENTITY],
        scope: { type: "workspace", workspaceId },
        organizationReads: {
          organizationId: "organization-b",
          resources: [RESOURCE_TYPE.USER],
        },
      },
    ),
  );
  const foreignResource = observe(
    resourceQueryOptions(
      queryOptions({
        queryKey: [...taskKeys.detail(workspaceId, taskId), "foreign-resource"],
      }),
      {
        resources: [RESOURCE_TYPE.ENTITY],
        scope: { type: "workspace", workspaceId },
        organizationReads: {
          organizationId,
          resources: [RESOURCE_TYPE.CONTACT],
        },
      },
    ),
  );
  return {
    client,
    detail,
    calendar,
    foreignOrganization,
    foreignResource,
    rename: () => {
      name = "Alpha";
    },
    settle: async () => {
      await Promise.all(
        client
          .getQueryCache()
          .findAll()
          .map(async (query) => await query.promise),
      );
    },
    close: () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      client.clear();
    },
  };
};

test.each([
  "success",
  "refusal",
  "other-user",
  "other-organization",
  "no-organization",
  "stale-auth-cache",
  "auth-transition",
])(
  "profile update refreshes only its captured organization's projection owners: %s",
  async (outcome) => {
    const readers = createReaders();
    if (outcome === "no-organization") {
      readers.client.setQueryData(rootKeys.session, sessionFor(userId, null));
    }
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: URL | RequestInfo) => {
          expect(
            input instanceof Request ? input.url : input.toString(),
          ).toContain("/update-user");
          if (outcome === "refusal") {
            return Response.json({ message: "Refused" }, { status: 403 });
          }
          readers.rename();
          if (outcome === "other-user") {
            readers.client.setQueryData(
              rootKeys.session,
              sessionFor("user-b", organizationId),
            );
          }
          if (outcome === "other-organization") {
            readers.client.setQueryData(
              rootKeys.session,
              sessionFor(userId, "organization-b"),
            );
          }
          return Response.json({ status: true });
        },
        { preconnect: () => undefined },
      ),
    );
    try {
      const result = await updateUserResource({
        queryClient: readers.client,
        input: { name: "Alpha" },
        owner:
          outcome === "auth-transition"
            ? null
            : {
                userId:
                  outcome === "stale-auth-cache"
                    ? "newly-signed-in-user"
                    : userId,
                organizationId:
                  outcome === "no-organization" ? null : organizationId,
              },
      });
      expect(Result.isError(result)).toBe(outcome === "refusal");
      await readers.settle();
      expect(readers.detail.value()).toBe(
        outcome === "success" ? "Alpha" : "Zulu",
      );
      expect(readers.calendar.value()).toBe(
        outcome === "success" ? "Alpha" : "Zulu",
      );
      expect(readers.foreignOrganization.value()).toBe("Zulu");
      expect(readers.foreignResource.value()).toBe("Zulu");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
      readers.close();
    }
  },
);

test("a session transition cancels and removes readers with organization projections", async () => {
  const readers = createReaders();
  const uninstall = installSessionCacheGuard(readers.client, {
    isAuthFlowPage: () => false,
    reloadDocument: () => undefined,
    reloadDocumentAt: () => undefined,
  });
  try {
    readers.client.setQueryData(
      rootKeys.session,
      sessionFor(userId, "organization-b"),
    );
    await settleAuthTransition(readers.client);
    expect(
      readers.client.getQueryState(readers.detail.queryKey),
    ).toBeUndefined();
    expect(
      readers.client.getQueryState(readers.calendar.queryKey),
    ).toBeUndefined();
  } finally {
    uninstall();
    readers.close();
  }
});

test.each(["known", "unknown"])(
  "auth refusal stays typed and never refreshes projections: %s",
  async (codeKind) => {
    const readers = createReaders();
    readers.rename();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () =>
          Response.json(
            {
              message: "Refused",
              code:
                codeKind === "known"
                  ? "DISPOSABLE_EMAIL_NOT_ALLOWED"
                  : "UNRECOGNIZED_REFUSAL",
            },
            { status: 403 },
          ),
        { preconnect: () => undefined },
      ),
    );
    const owner = { userId, organizationId };
    try {
      const update = createUserUpdateMutation({
        queryClient: readers.client,
        input: () => ({ name: "Alpha" }),
        owner,
      });
      const error = await rejectionOf(update());
      expect(
        codeKind === "known" ? AuthClientError.is(error) : APIError.is(error),
      ).toBe(true);
      const result = await updateUserResource({
        queryClient: readers.client,
        input: { name: "Alpha" },
        owner,
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(
          codeKind === "known"
            ? AuthClientError.is(result.error)
            : APIError.is(result.error),
        ).toBe(true);
      }
      await readers.settle();
      expect(readers.detail.value()).toBe("Zulu");
      expect(readers.calendar.value()).toBe("Zulu");
    } finally {
      fetch.mockRestore();
      readers.close();
    }
  },
);

class ProfileTransportError extends TaggedError("ProfileTransportError")<{
  message: string;
}> {}

test.each([
  new ProfileTransportError({ message: "Transport disconnected" }),
  { reason: "Transport disconnected" },
  "Transport disconnected",
])(
  "a transport rejection keeps its identity through both profile update entry points: %j",
  async (failure) => {
    const readers = createReaders();
    readers.rename();
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(failure);
    const owner = { userId, organizationId };
    try {
      const update = createUserUpdateMutation({
        queryClient: readers.client,
        input: () => ({ name: "Alpha" }),
        owner,
      });
      expect(await rejectionOf(update())).toBe(failure);
      expect(
        await rejectionOf(
          updateUserResource({
            queryClient: readers.client,
            input: { name: "Alpha" },
            owner,
          }),
        ),
      ).toBe(failure);
      await readers.settle();
      expect(readers.detail.value()).toBe("Zulu");
      expect(readers.calendar.value()).toBe("Zulu");
    } finally {
      fetch.mockRestore();
      readers.close();
    }
  },
);
