import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import { SelectRowContent } from "@/components/workspaces/table/select-row-content";
import type { StatuteRowData } from "@/components/workspaces/table/types";
import { WorkspaceGridRow } from "@/components/workspaces/table/workspace-grid";
import { selectColId } from "@/components/workspaces/table/workspace-table/internals-helpers";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cases" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { IntlProvider } = await import("use-intl");
const { PublicLawTable } = await import("./public-law-table");

afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

const layout: PublicLawTableLayout = {
  hidden: [],
  order: [],
  pinned: [],
  sizing: {},
  contentMode: "tight",
};
const rows = ["12 C 1/2026", "18 C 2/2026"].map((label): StatuteRowData => ({
  kind: "statute",
  children: [],
  statute: {
    amendmentCount: 0,
    citationCaseCount: null,
    country: "CZE",
    documentType: "zákon",
    documentUrl: null,
    effectiveDate: null,
    eli: label,
    firstVersionValidFrom: null,
    id: toSafeId<"legislationDocument">(createUuid()),
    language: "cs",
    lastAmendedOn: null,
    slug: null,
    sourceUrl: null,
    status: "current",
    title: label,
    validity: "in-force",
    versionValidFrom: null,
    versionValidTo: null,
  },
}));

const Fixture = () => {
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  return (
    <IntlProvider locale="en" messages={messages}>
      <PublicLawTable<StatuteRowData, PublicLawTableLayout>
        columns={[{ id: selectColId, accessorFn: () => null }]}
        firstRowNumber={1}
        getRowId={(row) => row.statute.id}
        isLoading={false}
        layout={layout}
        onLayoutChange={() => undefined}
        rowHost={{
          renderRow: (input) => (
            <WorkspaceGridRow>
              <SelectRowContent
                ariaLabel={input.selectionLabel}
                firstLine="text"
                index={input.index}
                label={input.rowLabel}
                lastSelectedIndex={input.lastSelectedIndex}
                row={input.row}
                table={input.table}
              />
            </WorkspaceGridRow>
          ),
        }}
        rows={rows}
        selection={{
          actions: null,
          clearLabel: messages.common.clearSelection,
          getRowLabel: (row) =>
            messages.common.selectRow.replace(
              "{label}",
              () => row.statute.title,
            ),
          label: messages.common.selectedCount.replace(
            "{count, plural, one {# selected} other {# selected}}",
            () => `${selectedIds.length} selected`,
          ),
          onSelectedIdsChange: setSelectedIds,
          selectedIds,
          selectAllLabel: messages.common.selectAllRows,
        }}
        sorting={null}
      />
    </IntlProvider>
  );
};

test("selection names rows and exposes count, clear, and page select-all", () => {
  const view = render(<Fixture />);
  const selectAll = view.getByRole("checkbox", {
    name: messages.common.selectAllRows,
  });
  const first = view.getByRole("checkbox", { name: /12 C 1\/2026/u });
  const second = view.getByRole("checkbox", { name: /18 C 2\/2026/u });

  fireEvent.click(first);
  fireEvent.click(second);
  expect(view.getByText("2 selected")).not.toBeNull();
  expect(selectAll.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(
    view.getByRole("button", { name: messages.common.clearSelection }),
  );
  expect(view.queryByText("2 selected")).toBeNull();
  expect(selectAll.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(selectAll);
  expect(view.getByText("2 selected")).not.toBeNull();
});
