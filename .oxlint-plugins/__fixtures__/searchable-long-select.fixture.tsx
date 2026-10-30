// expect-error-fixture
export const searchableLongSelect = String.raw`
import { Select, SelectItem } from "@stll/ui/select";
import { WEB_ROUTE_TEMPLATES as templates } from "@/route-templates.gen";

// expect-error: searchable-long-select/searchable-long-select
const longImportedList = <Select>{templates.map((template) => <SelectItem value={template}>{template}</SelectItem>)}</Select>;

// expect-clean: searchable-long-select/searchable-long-select
const shortExplicitList = <Select><SelectItem value="recent">Recent</SelectItem><SelectItem value="updated">Updated</SelectItem></Select>;
`;
