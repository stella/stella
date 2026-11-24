import {
  BROWSER_EXTENSION_STATUS,
  BROWSER_EXTENSION_STORE_URL,
  type BrowserExtensionStatus,
} from "@stll/api-contract/browser-control";

import { BrowserExtensionChipView } from "@/components/chat/browser-extension-chip";

const STATES: readonly {
  id: string;
  label: string;
  status: BrowserExtensionStatus;
}[] = [
  {
    id: "connected",
    label: "Connected",
    status: BROWSER_EXTENSION_STATUS.connected,
  },
  {
    id: "not-installed",
    label: "Not installed",
    status: BROWSER_EXTENSION_STATUS.notInstalled,
  },
  {
    id: "not-paired",
    label: "Not connected",
    status: BROWSER_EXTENSION_STATUS.notPaired,
  },
  {
    id: "stella-outdated",
    label: "Reload needed",
    status: BROWSER_EXTENSION_STATUS.stellaOutdated,
  },
];

export const BrowserExtensionChipPlayground = () => (
  <section
    className="flex min-h-dvh w-full flex-col justify-end gap-8 p-10 pb-16"
    data-playground-section="browser-extension-chip"
  >
    <div className="flex flex-wrap items-center gap-12">
      {STATES.map((entry) => (
        <div
          className="bg-card flex items-center gap-3 rounded-xl border px-4 py-2.5 shadow-xs"
          data-chip-state={entry.id}
          key={entry.id}
        >
          <span className="text-muted-foreground text-xs font-medium">
            {entry.label}
          </span>
          <BrowserExtensionChipView
            status={entry.status}
            storeUrl={BROWSER_EXTENSION_STORE_URL}
          />
        </div>
      ))}
    </div>
  </section>
);
