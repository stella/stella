import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
Object.assign(import.meta.env, { VITE_API_URL: "https://api.example.test" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: en } = await import("@/i18n/langs/en.json");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { workspacesNavigationOptions } =
  await import("@/lib/workspaces/queries");
const { toSafeId } = await import("@/lib/safe-id");
const { COMPOSER_LIST_VIEWPORT_CLASS_NAME } =
  await import("./composer-submenu-search");
const { ChatMatterPicker } = await import("./chat-matter-picker");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const ORGANIZATION_ID = "org-matter-picker";
const USER = {
  activeOrganizationId: ORGANIZATION_ID,
  email: "member@example.test",
  id: "user-matter-picker",
  image: null,
  name: "Member",
  preferredName: null,
  timezoneId: "UTC",
  wordEditShortcut: null,
};

// Enough matters that the list is longer than any sensible popup.
const MATTER_COUNT = 40;
const workspaces = Array.from({ length: MATTER_COUNT }, (_, index) => ({
  client: null,
  clientId: null,
  color: null,
  defaultViewId: toSafeId<"workspaceView">(
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  ),
  id: toSafeId<"workspace">(
    `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
  ),
  lastActivityAt: new Date("2026-07-30T12:00:00.000Z"),
  name: `Matter ${index}`,
  reference: `MAT-${index}`,
  status: "active" as const,
}));

const renderPicker = () => {
  const client = new QueryClient();
  client.setQueryData(
    workspacesNavigationOptions({
      organizationId: ORGANIZATION_ID,
      userId: USER.id,
    }).queryKey,
    { workspaces, features: { timeBilling: false } },
  );
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <AuthenticatedUserProvider user={USER}>
            <ChatMatterPicker matterIds={[]} onChange={() => {}} />
          </AuthenticatedUserProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

const openPicker = async () => {
  renderPicker();
  fireEvent.click(screen.getByRole("button"));
  return waitFor(() => {
    const menu = screen.getByRole("menu");
    expect(screen.getByText("Matter 0")).toBeTruthy();
    return menu;
  });
};

test("a long matter list scrolls inside a popup capped to the space around its trigger", async () => {
  await openPicker();
  const row = screen.getByText(`Matter ${MATTER_COUNT - 1}`);
  const viewport = row.closest(".overflow-y-auto");
  if (!(viewport instanceof HTMLElement)) {
    throw new Error("Expected the rows to sit in the menu's scrolling list");
  }
  // happy-dom has no layout, so the cap is checked where it is declared:
  // the shared composer list height, bounded by the available height.
  for (const className of COMPOSER_LIST_VIEWPORT_CLASS_NAME.split(" ")) {
    expect(viewport.classList.contains(className)).toBe(true);
  }
});

test("the title and search sit above the scrolling matters, never over them", async () => {
  await openPicker();
  const search = screen.getByPlaceholderText(
    en.inspector.matterPicker.searchPlaceholder,
  );
  const title = screen.getByText(en.inspector.matterPicker.title);
  const header = title.parentElement;
  const viewport = screen
    .getByText(`Matter ${MATTER_COUNT - 1}`)
    .closest(".overflow-y-auto");
  if (!header || !(viewport instanceof HTMLElement)) {
    throw new Error("Expected the picker header and its scrolling list");
  }
  expect(header.contains(search)).toBe(true);
  // The header is outside the scrolling list, so a row scrolled into view
  // while moving up with the keyboard can never end up hidden under it.
  expect(viewport.contains(header)).toBe(false);
  expect(header.nextElementSibling).toBe(viewport);
});
