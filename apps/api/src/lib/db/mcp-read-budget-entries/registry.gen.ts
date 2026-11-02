import entry0 from "./create_organization";
import entry1 from "./search";
import entry2 from "./search_across_matters";
import entry3 from "./search_legislation";

export default {
  "create_organization": entry0,
  "search": entry1,
  "search_across_matters": entry2,
  "search_legislation": entry3,
} as const;
