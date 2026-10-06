import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import messages from "@/i18n/langs/en.json";
import { browserStorage, deviceStorage } from "@/lib/account/browser-storage";

import type { ChatTurnPhase } from "./turn-notifications.logic";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, renderHook } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { CHAT_TURN_NOTIFICATIONS_STORAGE_KEY } =
  await import("./turn-notifications.logic");
const { setChatTurnNotificationsEnabled, useChatTurnNotifications } =
  await import("./use-chat-turn-notifications");

type Shown = {
  body: string | undefined;
  tag: string | undefined;
  title: string;
};

const shown: Shown[] = [];
const instances: FakeNotification[] = [];
let permission: NotificationPermission = "granted";
let pageInSight = false;

class FakeNotification extends EventTarget {
  static get permission() {
    return permission;
  }
  static requestPermission = async () => permission;
  closed = false;
  constructor(title: string, options?: NotificationOptions) {
    super();
    shown.push({ body: options?.body, tag: options?.tag, title });
    instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

Object.defineProperty(window, "Notification", {
  configurable: true,
  value: FakeNotification,
});
Object.defineProperty(document, "hasFocus", {
  configurable: true,
  value: () => pageInSight,
});

beforeEach(() => {
  shown.length = 0;
  instances.length = 0;
  permission = "granted";
  pageInSight = false;
  browserStorage("local")?.clear();
});
afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const mount = (initial: { conversationId: string; phase: ChatTurnPhase }) =>
  renderHook((props) => useChatTurnNotifications(props), {
    initialProps: initial,
    wrapper: ({ children }) => (
      <IntlProvider locale="en" messages={messages}>
        {children}
      </IntlProvider>
    ),
  });

describe("useChatTurnNotifications", () => {
  test("stays silent until the user opts in", () => {
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-a", phase: "idle" });

    expect(shown).toEqual([]);
  });

  test("tells a hidden page that the reply is ready, once per thread", async () => {
    expect(await setChatTurnNotificationsEnabled(true)).toBe("on");
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-a", phase: "idle" });
    hook.rerender({ conversationId: "thread-a", phase: "idle" });

    expect(shown).toEqual([
      {
        body: "stella finished answering in your chat.",
        tag: "stella-chat-thread-a",
        title: "Reply ready",
      },
    ]);
  });

  test("asks for the user's input when a turn stops on a card", async () => {
    await setChatTurnNotificationsEnabled(true);
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-a", phase: "awaiting-user" });

    expect(shown.map(({ title }) => title)).toEqual([
      "stella needs your input",
    ]);
  });

  test("does not carry a running turn over to another thread", async () => {
    await setChatTurnNotificationsEnabled(true);
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-b", phase: "idle" });

    expect(shown).toEqual([]);
  });

  test("leaves a page in sight alone", async () => {
    await setChatTurnNotificationsEnabled(true);
    pageInSight = true;
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-a", phase: "failed" });

    expect(shown).toEqual([]);
  });

  test("clicking the notification brings the page back and closes it", async () => {
    await setChatTurnNotificationsEnabled(true);
    let focused = 0;
    const previousFocus = window.focus;
    window.focus = () => {
      focused += 1;
    };
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-a", phase: "idle" });

    instances.at(-1)?.dispatchEvent(new Event("click"));

    expect(focused).toBe(1);
    expect(instances.at(-1)?.closed).toBe(true);
    window.focus = previousFocus;
  });
});

describe("setChatTurnNotificationsEnabled", () => {
  test("stays off when the browser permission is refused", async () => {
    permission = "denied";

    expect(await setChatTurnNotificationsEnabled(true)).toBe("denied");
    expect(
      deviceStorage("local").getItem(CHAT_TURN_NOTIFICATIONS_STORAGE_KEY),
    ).toBeNull();
  });

  test("turning it off clears the stored opt-in", async () => {
    await setChatTurnNotificationsEnabled(true);

    expect(await setChatTurnNotificationsEnabled(false)).toBe("off");
    expect(
      deviceStorage("local").getItem(CHAT_TURN_NOTIFICATIONS_STORAGE_KEY),
    ).toBeNull();
  });

  test("a revoked permission silences a stored opt-in", async () => {
    await setChatTurnNotificationsEnabled(true);
    permission = "denied";
    const hook = mount({ conversationId: "thread-a", phase: "running" });
    hook.rerender({ conversationId: "thread-a", phase: "idle" });

    expect(shown).toEqual([]);
  });
});
