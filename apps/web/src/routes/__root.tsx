import { useEffect, useState } from "react";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useShallow } from "zustand/react/shallow";

import {
  DefaultErrorComponent,
  DefaultPendingComponent,
} from "@/components/route-components";
import { useDevStore } from "@/lib/dev-store";
import { sessionOptions } from "@/routes/-queries";

const isDev = import.meta.env.DEV;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootComponent,
  // Document head management via route `head` option.
  // https://tanstack.com/router/latest/docs/framework/react/guide/document-head-management
  head: () => ({
    meta: [{ title: "stella" }],
  }),
  beforeLoad: async ({ context }) => {
    const sessionData =
      await context.queryClient.ensureQueryData(sessionOptions);

    return {
      session: sessionData?.session,
      user: sessionData?.user,
    };
  },
  pendingComponent: () => <DefaultPendingComponent className="h-screen" />,
  errorComponent: (props) => (
    <DefaultErrorComponent className="h-screen" {...props} />
  ),
});

function DevRoot() {
  const [tanstackDevtools, sourceInspector, rivetDevtools] = useDevStore(
    useShallow((s) => [s.tanstackDevtools, s.sourceInspector, s.rivetDevtools]),
  );

  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.querySelector<HTMLElement>("rivetkit-devtools");
    if (el) {
      setElement(el);
      return;
    }

    const observer = new MutationObserver((_, obs) => {
      const found = document.querySelector<HTMLElement>("rivetkit-devtools");
      if (found) {
        setElement(found);
        obs.disconnect();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (element) {
      element.style.display = rivetDevtools ? "" : "none";
    }
  }, [element, rivetDevtools]);

  return tanstackDevtools ? (
    <TanStackDevtools
      config={{
        inspectHotkey: sourceInspector ? ["Shift", "CtrlOrMeta"] : [],
      }}
      plugins={[
        {
          name: "React Query",
          render: <ReactQueryDevtoolsPanel />,
        },
        {
          name: "TanStack Router",
          render: <TanStackRouterDevtoolsPanel />,
        },
      ]}
    />
  ) : null;
}

function RootComponent() {
  useSuspenseQuery(sessionOptions);

  return (
    <>
      <HeadContent />
      <div className="flex h-screen w-full flex-col">
        <Outlet />
        {isDev && <DevRoot />}
      </div>
    </>
  );
}
