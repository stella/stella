import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";
import { stellaToast } from "@stll/ui/toast";

import arabic from "@/i18n/langs/ar.json";
import czech from "@/i18n/langs/cs.json";
import english from "@/i18n/langs/en.json";
import { getTranslator, setTranslator } from "@/i18n/translator";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { useStartVerification } = await import("./use-start-verification");
const workspaceId = "019a0000-0000-7000-8000-000000000001";
const listId = "019a0000-0000-7000-8000-000000000002";
const target = {
  entityId: "019a0000-0000-7000-8000-000000000003",
  fileFieldId: "019a0000-0000-7000-8000-000000000004",
};
const runId = "019a0000-0000-7000-8000-000000000005";
const originalTranslator = getTranslator();
const clients: InstanceType<typeof QueryClient>[] = [];
const spies: { mockRestore: () => void }[] = [];
const mountStart = (locale = "en", messages = english) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const opened: string[] = [];
  const invalidation = spyOn(client, "invalidateQueries");
  spies.push(invalidation);
  setTranslator(createTranslator({ locale, messages }));
  const hook = renderHook(
    () =>
      useStartVerification({
        workspaceId,
        listId,
        onStarted: (id) => opened.push(id),
      }),
    {
      wrapper: ({ children }) => (
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </IntlProvider>
      ),
    },
  );
  return { ...hook, client, opened, invalidation };
};
const answer = (
  respond: (request: Request) => Promise<Response> | Response,
) => {
  const boundary = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        await respond(new Request(input, init)),
      { preconnect: () => undefined },
    ),
  );
  spies.push(boundary);
  return boundary;
};
const watchToast = () => {
  const toast = spyOn(stellaToast, "add").mockReturnValue("verification-toast");
  spies.push(toast);
  return toast;
};
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
  setTranslator(originalTranslator);
});
afterAll(async () => await GlobalRegistrator.unregister());
for (const { locale, messages } of [
  { locale: "en", messages: english },
  { locale: "cs", messages: czech },
  { locale: "ar", messages: arabic },
]) {
  for (const code of Object.values(VERIFICATION_RUN_CAP_CODES)) {
    test(`${locale}: ${code} shows a localized limit and clears the pending start`, async () => {
      const boundary = answer(() =>
        Response.json(
          { code, message: "Server English text", retryable: true },
          { status: 429 },
        ),
      );
      const toast = watchToast();
      const { result, opened, invalidation } = mountStart(locale, messages);
      await act(async () => await result.current.start(target));
      const expected =
        code === VERIFICATION_RUN_CAP_CODES.active
          ? messages.errors.apiCodes.verificationActiveLimitReached
          : messages.errors.apiCodes.verificationDailyLimitReached;
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expected, type: "error" }),
      );
      expect(boundary).toHaveBeenCalledTimes(1);
      expect(opened).toEqual([]);
      expect(invalidation).not.toHaveBeenCalled();
      expect(result.current.startingFor).toBeNull();
      expect(result.current.sizeConfirmation).toBeNull();
    });
  }
}
test("a failed transport shows the start failure and clears the pending document", async () => {
  answer(() => {
    throw new TypeError("Network unavailable");
  });
  const toast = watchToast();
  const { result, opened } = mountStart();
  await act(async () => await result.current.start(target));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: english.avt.runs.startFailed }),
  );
  expect(opened).toEqual([]);
  expect(result.current.startingFor).toBeNull();
});
test("an unclassified server error uses the localized start failure", async () => {
  answer(() =>
    Response.json({ message: "Server diagnostic" }, { status: 500 }),
  );
  const toast = watchToast();
  const { result, opened } = mountStart();
  await act(async () => await result.current.start(target));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: english.avt.runs.startFailed }),
  );
  expect(opened).toEqual([]);
  expect(result.current.startingFor).toBeNull();
});
test("a successful start sends the document and opens the returned run", async () => {
  const bodies: unknown[] = [];
  answer(async (request) => {
    bodies.push(await request.json());
    return Response.json({ runId });
  });
  const { result, opened, invalidation } = mountStart();
  await act(async () => await result.current.start(target));
  expect(bodies).toEqual([{ listId, ...target }]);
  expect(opened).toEqual([runId]);
  expect(invalidation).toHaveBeenCalledTimes(2);
  expect(result.current.startingFor).toBeNull();
});
test("a size refusal waits for confirmation, then sends the accepted size", async () => {
  const bodies: unknown[] = [];
  answer(async (request) => {
    bodies.push(await request.json());
    return bodies.length === 1
      ? Response.json(
          {
            code: "usage_confirmation_required",
            message: "Confirm the estimated run size.",
            confirmation: { estimatedUnits: 12, availableUnits: 20 },
          },
          { status: 428 },
        )
      : Response.json({ runId });
  });
  const { result, opened } = mountStart();
  await act(async () => await result.current.start(target));
  expect(result.current.sizeConfirmation).toEqual({
    target,
    estimatedUnits: 12,
    availableUnits: 20,
  });
  expect(opened).toEqual([]);
  await act(async () => await result.current.start(target, 12));
  expect(bodies.at(1)).toEqual({ listId, ...target, confirmedUnits: 12 });
  expect(opened).toEqual([runId]);
  expect(result.current.sizeConfirmation).toBeNull();
});
