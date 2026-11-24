import type { ReactNode } from "react";

import { Frame } from "@stll/ui/frame";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { SortableHeadFace } from "@stll/ui/table-shell";

import type { sortableHeadBenches } from "../-visual-metadata";

const sortNowhere = () => undefined;

/**
 * Tables far wider than their head labels, in the frame settings pages use.
 * Every label has room, so none may end in an ellipsis.
 */
const BENCH = {
  "empty-body": (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead onSort={sortNowhere} sortDirection="asc">
            Uživatel
          </SortableHead>
          <SortableHead onSort={sortNowhere}>Role</SortableHead>
          <SortableHead onSort={sortNowhere}>Připojil/a se</SortableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell align="center" colSpan={4} tone="muted">
            Nebyli nalezeni žádní členové
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  "with-rows": (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead onSort={sortNowhere}>Mandant</SortableHead>
          <SortableHead onSort={sortNowhere} sortDirection="desc">
            Zuständige Person
          </SortableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Harbour Legal</TableCell>
          <TableCell>A. Novak</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  "end-aligned": (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead onSort={sortNowhere}>Matter</SortableHead>
          <SortableHead numeric onSort={sortNowhere} sortDirection="asc">
            Billable hours
          </SortableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Supply agreement</TableCell>
          <TableCell numeric>12.5</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  face: (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHeadFace sortDirection="asc">Uživatel</SortableHeadFace>
          <SortableHeadFace>Připojil/a se</SortableHeadFace>
          <SortableHeadFace numeric>Billable hours</SortableHeadFace>
        </TableRow>
      </TableHeader>
    </Table>
  ),
} as const satisfies Record<keyof typeof sortableHeadBenches, ReactNode>;

export const SortableHeadPlayground = () => (
  <div className="flex flex-col gap-6 p-4">
    {Object.entries(BENCH).map(([state, table]) => (
      <section
        className="flex w-[40rem] flex-col gap-2"
        data-playground-section={`sortable-head:${state}`}
        key={state}
      >
        <h2 className="text-muted-foreground text-xs">{state}</h2>
        <Frame>{table}</Frame>
      </section>
    ))}
  </div>
);
