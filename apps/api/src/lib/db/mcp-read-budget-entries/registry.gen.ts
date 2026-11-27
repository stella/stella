import entry0 from "./create_organization";
import entry1 from "./list_case_law_courts";
import entry2 from "./read_guidance";
import entry3 from "./read_site_notes";
import entry4 from "./reformat_into_template";
import entry5 from "./save_site_notes";
import entry6 from "./search";
import entry7 from "./search_across_matters";
import entry8 from "./search_guidance";
import entry9 from "./search_legislation";
import entry10 from "./verify_quote";

export default {
  "create_organization": entry0,
  "list_case_law_courts": entry1,
  "read_guidance": entry2,
  "read_site_notes": entry3,
  "reformat_into_template": entry4,
  "save_site_notes": entry5,
  "search": entry6,
  "search_across_matters": entry7,
  "search_guidance": entry8,
  "search_legislation": entry9,
  "verify_quote": entry10,
} as const;
