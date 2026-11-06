import entry0 from "./create_organization";
import entry1 from "./list_case_law_courts";
import entry2 from "./search";
import entry3 from "./search_across_matters";
import entry4 from "./search_legislation";
import entry5 from "./verify_quote";

export default {
  "create_organization": entry0,
  "list_case_law_courts": entry1,
  "search": entry2,
  "search_across_matters": entry3,
  "search_legislation": entry4,
  "verify_quote": entry5,
} as const;
