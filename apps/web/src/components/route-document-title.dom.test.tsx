import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

import { routePresentation } from "@/lib/route-presentation";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/matters/1/document" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} = await import("@tanstack/react-router");
const { RouteDocumentTitle } = await import("./route-document-title");

afterAll(unregisterDomEnvironment);

test("the deepest live entity route remains the only document title owner", async () => {
  const root = createRootRoute({ component: Outlet });
  const MatterTitle = () => {
    const [name, setName] = useState("Initial matter");
    return (
      <>
        <RouteDocumentTitle routeId={matter.id} title={name} />
        <button onClick={() => setName("Renamed matter")} type="button" />
        <button onClick={() => setName("Final matter name")} type="button" />
        <Outlet />
      </>
    );
  };
  const matter = createRoute({
    getParentRoute: () => root,
    path: "matters/$matterId",
    staticData: {
      presentation: routePresentation({ type: "entity", entity: "matter" }),
    },
    component: MatterTitle,
  });
  const overview = createRoute({
    getParentRoute: () => matter,
    path: "/",
    component: () => null,
  });
  const DocumentTitle = () => {
    const [name, setName] = useState("Agreement.docx");
    return (
      <>
        <RouteDocumentTitle routeId={documentRoute.id} title={name} />
        <button
          onClick={() => setName("Signed agreement.docx")}
          type="button"
        />
      </>
    );
  };
  const documentRoute = createRoute({
    getParentRoute: () => matter,
    path: "document",
    staticData: {
      presentation: routePresentation({ type: "entity", entity: "pdf" }),
    },
    component: DocumentTitle,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      matter.addChildren([overview, documentRoute]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/matters/1/document"],
    }),
  });

  try {
    await act(async () => {
      await router.load();
      render(<RouterProvider router={router} />);
    });
    await waitFor(() => expect(document.title).toBe("Agreement.docx | stella"));
    expect(document.querySelectorAll("title")).toHaveLength(1);

    fireEvent.click(document.querySelectorAll("button").item(0));
    await waitFor(() => expect(document.title).toBe("Agreement.docx | stella"));

    fireEvent.click(document.querySelectorAll("button").item(2));
    await waitFor(() =>
      expect(document.title).toBe("Signed agreement.docx | stella"),
    );

    await act(async () => {
      router.history.push("/matters/1");
      await router.load();
    });
    await waitFor(() => expect(document.title).toBe("Renamed matter | stella"));

    fireEvent.click(document.querySelectorAll("button").item(1));
    await waitFor(() =>
      expect(document.title).toBe("Final matter name | stella"),
    );
  } finally {
    cleanup();
  }
});
