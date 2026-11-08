import { Select, SelectItem } from "@stll/ui/select";
import { WEB_ROUTE_TEMPLATES as templates } from "@/route-templates.gen";

export const longImportedList = (
  // oxlint-disable-next-line searchable-long-select/searchable-long-select
  <Select>
    {templates.map((template) => (
      <SelectItem key={template} value={template}>
        {template}
      </SelectItem>
    ))}
  </Select>
);

// expect-clean: searchable-long-select/searchable-long-select
export const shortExplicitList = (
  <Select>
    <SelectItem value="recent">Recent</SelectItem>
    <SelectItem value="updated">Updated</SelectItem>
  </Select>
);
