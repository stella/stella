// Passive regression fixture for
// `settings-layout-primitives/settings-layout-primitives`: a settings page
// that loads an ad-hoc card or a table module is reported once per load.

// expect-clean: settings-layout-primitives/settings-layout-primitives
import { SettingsRow, SettingsSection } from "@stll/ui/settings";
// oxlint-disable-next-line settings-layout-primitives/settings-layout-primitives -- ad-hoc card
import { Frame } from "@stll/ui/frame";
// oxlint-disable-next-line settings-layout-primitives/settings-layout-primitives -- inventory table
import { Table } from "@stll/ui/table";
import type { TableSkeletonRows } from "@stll/ui/table-shell";

// oxlint-disable-next-line settings-layout-primitives/settings-layout-primitives -- dynamic import
const lazyShell = import("@stll/ui/table-shell");

export { Frame, lazyShell, SettingsRow, SettingsSection, Table };
export type { TableSkeletonRows };
