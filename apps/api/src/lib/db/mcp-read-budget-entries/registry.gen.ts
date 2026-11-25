import entry0 from "./create_organization";
import entry1 from "./list_case_law_courts";
import entry2 from "./list_site_notes";
import entry3 from "./read_guidance";
import entry4 from "./save_site_notes";
import entry5 from "./search";
import entry6 from "./search_across_matters";
import entry7 from "./search_guidance";
import entry8 from "./search_legislation";
import entry9 from "./verify_quote";

export default {
  "create_organization": entry0,
  "list_case_law_courts": entry1,
  "list_site_notes": entry2,
  "read_guidance": entry3,
  "save_site_notes": entry4,
  "search": entry5,
  "search_across_matters": entry6,
  "search_guidance": entry7,
  "search_legislation": entry8,
  "verify_quote": entry9,
} as const;
