import entry0 from "./create_organization";
import entry1 from "./list_case_law_courts";
import entry2 from "./read_guidance";
import entry3 from "./search";
import entry4 from "./search_across_matters";
import entry5 from "./search_guidance";
import entry6 from "./search_legislation";
import entry7 from "./verify_quote";

export default {
  "create_organization": entry0,
  "list_case_law_courts": entry1,
  "read_guidance": entry2,
  "search": entry3,
  "search_across_matters": entry4,
  "search_guidance": entry5,
  "search_legislation": entry6,
  "verify_quote": entry7,
} as const;
