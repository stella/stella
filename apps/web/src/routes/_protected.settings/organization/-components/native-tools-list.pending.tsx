import { InputFace } from "@stll/ui/control-face";
import { SearchIcon } from "@stll/ui/icons";
import { List, ListItemSkeleton } from "@stll/ui/list-shell";

const ROW_KEYS = ["first", "second", "third", "fourth", "fifth"];

export function NativeToolsSearchFace() {
  return <InputFace className="min-h-11 sm:min-h-0" icon={<SearchIcon />} />;
}

export function NativeToolsRowsPending() {
  return (
    <List aria-busy="true">
      {ROW_KEYS.map((key, index) => (
        <ListItemSkeleton index={index} key={key} media trailing="text" />
      ))}
    </List>
  );
}
