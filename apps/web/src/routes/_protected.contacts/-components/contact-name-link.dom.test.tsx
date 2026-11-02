import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/contacts" });

const testing = await import("@testing-library/react");
const router = await import("@tanstack/react-router");
const { ContactNameLink } =
  await import("@/routes/_protected.contacts/-components/contact-name-link");

const CONTACT_ID = "00000000-0000-4000-8000-000000000001";
const NEIGHBOUR_CELL = "person@example.com";
const DIRECTIONAL_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u;

const renderInTable = async (displayName: string) => {
  const root = router.createRootRoute({
    component: () => (
      <table>
        <tbody>
          <tr>
            <td>
              <ContactNameLink
                contactId={CONTACT_ID}
                displayName={displayName}
              />
            </td>
            <td>{NEIGHBOUR_CELL}</td>
          </tr>
        </tbody>
      </table>
    ),
  });
  const contactsRoute = router.createRoute({
    getParentRoute: () => root,
    path: "/contacts",
  });
  const contactRoute = router.createRoute({
    getParentRoute: () => root,
    path: "/contacts/$contactId",
  });
  const appRouter = router.createRouter({
    routeTree: root.addChildren([contactsRoute, contactRoute]),
    history: router.createMemoryHistory({ initialEntries: ["/contacts"] }),
    isServer: false,
  });
  const view = testing.render(<router.RouterProvider router={appRouter} />);
  return await view.findByRole("link");
};

afterEach(() => {
  testing.cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a stored override renders the name in the order it was typed", async () => {
  const link = await renderInTable("Jana \u202Ekcab <b>x</b>");

  expect(link.textContent).toBe("Jana kcab <b>x</b>");
  expect(link.textContent).not.toMatch(DIRECTIONAL_CONTROL);
  expect(link.querySelector("b")).toBeNull();
  expect(link.getAttribute("href")).toBe(`/contacts/${CONTACT_ID}`);
});

test("the name is isolated from the neighbouring cells", async () => {
  const link = await renderInTable("עמית כהן");
  const name = link.querySelector("[dir='auto']");

  expect(name?.textContent).toBe("עמית כהן");
  expect(name?.className).toContain("[unicode-bidi:isolate]");
  expect(link.closest("td")?.textContent).toBe("עמית כהן");
});
