// Passive regression fixture for `require-entity-actions-row`.

import { EntityActions, EntityActionsButton } from "@stll/ui/entity-actions";
import { EllipsisVerticalIcon } from "@stll/ui/icons";
import { Menu, MenuTrigger } from "@stll/ui/menu";
import { TableCell, TableRow } from "@stll/ui/table";

export const _flagged = () => (
  <TableRow>
    <TableCell>
      {/* oxlint-disable-next-line require-entity-actions-row/require-entity-actions-row */}
      <Menu>
        <MenuTrigger>
          <EllipsisVerticalIcon />
        </MenuTrigger>
      </Menu>
    </TableCell>
  </TableRow>
);

export const _allowed = () => (
  <EntityActions actions={[]} label="Actions" render={<TableRow />}>
    <TableCell>
      {/* expect-clean: require-entity-actions-row/require-entity-actions-row */}
      <EntityActionsButton />
    </TableCell>
  </EntityActions>
);
