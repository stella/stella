import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, act } = await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { stellaToast } = await import("@stll/ui/toast");
const { toAPIError } = await import("@/lib/errors/api");
const { externalReferencePreviewOptions } =
  await import("./external-reference-preview");

const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(async () => {
  await act(async () => cleanup());
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test.each([500, 503])(
  "external previews retain localized failure descriptions for status %i",
  async (status) => {
    const privateMessage = "Unexpected provider response detail";
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => Response.json({ message: privateMessage }, { status }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    try {
      const options = externalReferencePreviewOptions({
        url: `https://example.test/preview-${status}`,
        errorTitle: messages.common.somethingWentWrong,
      });
      const result = await Result.tryPromise(
        async () => await client.query(options),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.cause).toMatchObject({ status });
      }
      expect(toast).toHaveBeenCalledTimes(1);
      const error = toAPIError({ status, value: { message: privateMessage } });
      expect(error.message).not.toBe(privateMessage);
      expect(toast).toHaveBeenCalledWith({
        type: "error",
        title: messages.common.somethingWentWrong,
        description: error.message,
      });
      expect(JSON.stringify(toast.mock.calls)).not.toContain(privateMessage);
      const retry = await Result.tryPromise(
        async () => await client.query(options),
      );
      expect(retry.isErr()).toBe(true);
      if (retry.isErr()) {
        expect(retry.error.cause).toMatchObject({ status });
      }
      expect(toast).toHaveBeenCalledTimes(1);
    } finally {
      toast.mockRestore();
      fetch.mockRestore();
    }
  },
);
