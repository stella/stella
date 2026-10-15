import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/frame" });

const originalFetch = globalThis.fetch;
let responseStatus = 200;
globalThis.fetch = Object.assign(
  async () => {
    expect(document.documentElement.hidden).toBe(false);
    return Response.json(
      responseStatus === 200 ? { success: true } : { message: "unavailable" },
      { status: responseStatus },
    );
  },
  { preconnect: () => undefined },
);

const { signOutAndRelease } = await import("@/hooks/use-sign-out");
const { releaseUserStorage, storageOwner } =
  await import("@/lib/account/user-scoped-storage");

beforeEach(() => {
  document.documentElement.hidden = false;
  releaseUserStorage();
});

afterAll(async () => {
  document.documentElement.hidden = false;
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

test.each([200, 503])(
  "updates document visibility after sign-out: %i",
  async (status) => {
    responseStatus = status;

    const result = await signOutAndRelease();

    expect(result.error === null).toBe(status === 200);
    expect(document.documentElement.hidden).toBe(status === 200);
    expect(storageOwner()).toEqual({ kind: "visitor" });
  },
);
