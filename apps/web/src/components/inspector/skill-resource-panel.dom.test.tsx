import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import type { InstalledSkillResourceTab } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: originalFetch.preconnect,
});
const { stellaToast } = await import("@stll/ui/toast");
const { cleanup, render, screen, fireEvent, waitFor, act } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { roleOptions } = await import("@/lib/auth-queries");
const { skillDetailOptions } = await import("@/lib/knowledge/queries");
const { toSafeId } = await import("@/lib/safe-id");
const { toAPIError } = await import("@/lib/errors/api");
const { SkillResourcePanel } = await import("./skill-resource-panel");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const tab = {
  type: "skill-resource",
  id: "skill-resource:skill:notes.txt",
  label: "notes.txt",
  skillName: "test-skill",
  origin: "authored",
  skillId: "skill",
  target: "resource",
  resourcePath: "notes.txt",
  mimeType: "text/plain",
  content: "Original notes",
} as const satisfies InstalledSkillResourceTab;

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(roleOptions.queryKey, "admin");
  client.setQueryData(
    skillDetailOptions("organization", "user", "skill").queryKey,
    {
      id: toSafeId<"agentSkill">("skill"),
      scope: "team",
      origin: "authored",
      userId: "user",
      slug: "test-skill",
      name: "Test skill",
      description: "Test instructions",
      version: null,
      license: null,
      compatibility: null,
      sourceUrl: null,
      contentHash: "hash",
      enabled: true,
      body: "Instructions",
      command: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      resources: [],
    },
  );
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "organization",
            email: "member@example.test",
            id: "user",
            image: null,
            name: "Member",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <SkillResourcePanel tab={tab} onClose={() => undefined} />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test.each([403, 404, 409, 500])(
  "resource text saves preserve localized refusal descriptions for status %i",
  async (status) => {
    const privateMessage = "Private resource storage details";
    const requests: { path: string; method: string; body: unknown }[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          const request = new Request(input, init);
          requests.push({
            path: new URL(request.url).pathname,
            method: request.method,
            body: await request.json(),
          });
          return Response.json({ message: privateMessage }, { status });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
    try {
      mount();
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.edit }),
        ),
      );
      const editor = screen.getByRole("textbox", {
        name: messages.common.edit,
      });
      await act(async () =>
        fireEvent.change(editor, { target: { value: "Updated notes" } }),
      );
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: messages.common.save }),
        ),
      );
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      expect(requests).toEqual([
        {
          path: "/v1/skills/skill/resources",
          method: "PATCH",
          body: { path: "notes.txt", content: "Updated notes" },
        },
      ]);
      expect(toast.mock.calls.at(0)?.at(0)).toMatchObject({
        type: "error",
        description: toAPIError({ status, value: { message: privateMessage } })
          .message,
      });
      expect(JSON.stringify(toast.mock.calls)).not.toContain(privateMessage);
      expect("value" in editor ? editor.value : undefined).toBe(
        "Updated notes",
      );
      expect(
        screen
          .getByRole("button", { name: messages.common.save })
          .hasAttribute("disabled"),
      ).toBe(false);
    } finally {
      toast.mockRestore();
      fetch.mockRestore();
    }
  },
);
