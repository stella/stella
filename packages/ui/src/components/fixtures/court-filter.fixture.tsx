import { useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { CourtFilter } from "../court-filter";
import "./court-filter.fixture.css";

const params = new URLSearchParams(location.search);
const rtl = params.get("locale") === "ar";
document.documentElement.dir = rtl ? "rtl" : "ltr";
document.documentElement.lang = rtl ? "ar" : "en";
const labels = rtl
  ? {
      court: "المحاكم",
      tier: "المحاكم العليا",
      search: "بحث",
      clear: "مسح",
      empty: "لا توجد نتائج",
      hint: "حدد المحاكم",
    }
  : {
      court: "Courts",
      tier: "Supreme courts",
      search: "Search",
      clear: "Clear",
      empty: "No matches",
      hint: "Select courts",
    };

const Fixture = () => {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <main>
      <CourtFilter
        mode="multiple"
        groups={[
          {
            value: "supreme",
            label: labels.tier,
            courts: [{ value: "NS" }, { value: "US" }],
          },
        ]}
        label={labels.court}
        selected={selected}
        onChange={setSelected}
        maxSelections={params.get("cap") === "two" ? 2 : 1}
        selectionHint={labels.hint}
        searchLabel={labels.search}
        clearLabel={labels.clear}
        emptyLabel={labels.empty}
        matchText={(value) => value.toLowerCase()}
      />
      <output aria-label="Selected courts">{JSON.stringify(selected)}</output>
    </main>
  );
};

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing fixture root");
}
createRoot(root).render(<Fixture />);
