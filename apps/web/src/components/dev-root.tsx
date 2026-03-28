import { useEffect, useState } from "react";

import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useShallow } from "zustand/react/shallow";

import { useDevStore } from "@/lib/dev-store";

export default function DevRoot() {
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
