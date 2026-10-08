import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";

const sessionArea = () =>
  browserStorage("session") ?? panic("Test requires session browser storage");

GlobalRegistrator.register({ url: "http://localhost:3000/frame" });

const { QueryClient } = await import("@tanstack/react-query");
const { rootKeys } = await import("@/lib/auth-queries");
const { installSessionChangeListener } =
  await import("@/lib/account/session-change-listener");
const { listenForSessionDocumentRestore } =
  await import("@/lib/account/session-document");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");

const originalFetch = globalThis.fetch;
let sessionReads = 0;
globalThis.fetch = Object.assign(
  async () => {
    sessionReads += 1;
    return Response.json({ message: "unavailable" }, { status: 503 });
  },
  { preconnect: () => undefined },
);

beforeEach(() => {
  document.documentElement.hidden = false;
  sessionArea().clear();
  releaseUserStorage();
  sessionReads = 0;
});

afterEach(() => {
  document.documentElement.hidden = false;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

const installOwner = (userId: string | null) => {
  const queryClient = new QueryClient();
  const stop = installUserScopedStorage(queryClient);
  queryClient.setQueryData(
    rootKeys.session,
    userId === null ? null : { user: { id: userId } },
  );
  stop();
  return queryClient;
};

const pageShow = (persisted: boolean) => {
  // The DOM harness exposes PageTransitionEvent as Event.
  const event = new PageTransitionEvent("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  expect(event.persisted).toBe(persisted);
  return event;
};

describe("session document restoration", () => {
  test.each([
    { current: "member-one", stored: "u:member-one", restored: true },
    { current: "member-one", stored: "u:member-two", restored: false },
    { current: "member-one", stored: "visitor", restored: false },
    { current: "member-one", stored: null, restored: false },
    { current: null, stored: "visitor", restored: false },
    { current: null, stored: "u:member-one", restored: false },
  ])(
    "restores according to the current owner: %j",
    ({ current, stored, restored }) => {
      installOwner(current);
      if (stored === null) {
        sessionArea().removeItem("stella.storage-owner");
      } else {
        sessionArea().setItem("stella.storage-owner", stored);
      }
      let resumed = 0;
      const reload = spyOn(window.location, "reload").mockImplementation(() => {
        expect(document.documentElement.hidden).toBe(true);
      });
      const stop = listenForSessionDocumentRestore(() => {
        resumed += 1;
      });
      try {
        window.dispatchEvent(pageShow(true));

        expect(resumed).toBe(restored ? 1 : 0);
        expect(reload).toHaveBeenCalledTimes(restored ? 0 : 1);
        expect(document.documentElement.hidden).toBe(!restored);
      } finally {
        stop();
        reload.mockRestore();
      }
    },
  );

  test("ordinary page display leaves the document visible", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );
    let resumed = 0;
    const stop = listenForSessionDocumentRestore(() => {
      resumed += 1;
    });
    try {
      window.dispatchEvent(pageShow(false));

      expect(resumed).toBe(0);
      expect(reload).not.toHaveBeenCalled();
      expect(document.documentElement.hidden).toBe(false);
    } finally {
      stop();
      reload.mockRestore();
    }
  });

  test("released owners start a new document without a session read", () => {
    const queryClient = installOwner("member-one");
    const reload = spyOn(window.location, "reload").mockImplementation(() => {
      expect(document.documentElement.hidden).toBe(true);
    });
    const stop = installSessionChangeListener(queryClient, {
      listen: () => () => undefined,
      onRestore: listenForSessionDocumentRestore,
      isHidden: () => false,
      onVisible: () => () => undefined,
      reloadDocument: () => window.location.reload(),
    });
    try {
      releaseUserStorage();
      window.dispatchEvent(pageShow(true));

      expect(reload).toHaveBeenCalledTimes(1);
      expect(document.documentElement.hidden).toBe(true);
      expect(sessionReads).toBe(0);
    } finally {
      stop();
      reload.mockRestore();
      queryClient.clear();
    }
  });

  test("the subscription ends when removed", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => undefined,
    );
    const stop = listenForSessionDocumentRestore(() => undefined);
    stop();
    try {
      window.dispatchEvent(pageShow(true));

      expect(reload).not.toHaveBeenCalled();
      expect(document.documentElement.hidden).toBe(false);
    } finally {
      reload.mockRestore();
    }
  });
});
