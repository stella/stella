import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const IMPORTS = 'import { Select, SelectItem } from "@stll/ui/select";';

test("rejects explicit long option lists and mapped statically long sources", async () => {
  const options = Array.from(
    { length: 31 },
    (_, index) => `<SelectItem value="${index}">${index}</SelectItem>`,
  ).join("\n");
  const list = Array.from({ length: 31 }, (_, index) => `"zone-${index}"`).join(
    ", ",
  );
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
const options = [${list}];
const explicit = <Select>${options}</Select>;
const mapped = <Select>{options.map((option) => <SelectItem value={option}>{option}</SelectItem>)}</Select>;
const native = <select>{options.map((option) => <option value={option}>{option}</option>)}</select>;
const chooseOptions = (fallback: boolean) => fallback ? options : [];
const throughHelper = <Select>{chooseOptions(true).map((option) => <SelectItem value={option}>{option}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3, 34, 35, 37]);
});

test("resolves the shared time-zone list import", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
import { COMMON_TIMEZONES as zones } from "@/lib/timezones";
const select = <Select>{zones.map((zone) => <SelectItem value={zone}>{zone}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3]);
});

test("recognizes aliased Select imports and only flags helpers used as map sources", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `import { Select as Picker, SelectItem as PickerItem } from "@stll/ui/select";
import { COMMON_TIMEZONES as zones } from "@/lib/timezones";
const zoneOptions = (current: string) => zones.includes(current) ? zones : [current, ...zones];
const timezoneLabel = () => zones.length > 0 ? "available" : "none";
const long = <Picker>{zoneOptions("UTC").map((zone) => <PickerItem value={zone}>{zone}</PickerItem>)}</Picker>;
const unrelatedCall = <Picker><span>{timezoneLabel()}</span></Picker>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([5]);
});

test("resolves an aliased list imported from another web module", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
import { WEB_ROUTE_TEMPLATES as templates } from "@/route-templates.gen";
const select = <Select>{templates.map((template) => <SelectItem value={template}>{template}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3]);
});

test("allows short lists and unrelated Select components", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
const short = ["a", "b"];
const select = <Select>{short.map((option) => <SelectItem value={option}>{option}</SelectItem>)}</Select>;
const local = <LocalSelect>{short.map((option) => <LocalItem>{option}</LocalItem>)}</LocalSelect>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("distinguishes same-named list bindings in separate components", async () => {
  const longList = Array.from(
    { length: 31 },
    (_, index) => `"zone-${index}"`,
  ).join(", ");
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
const LongPicker = () => {
  const options = [${longList}];
  return <Select>{options.map((option) => <SelectItem value={option}>{option}</SelectItem>)}</Select>;
};
const ShortPicker = () => {
  const options = ["a", "b"];
  return <Select>{options.map((option) => <SelectItem value={option}>{option}</SelectItem>)}</Select>;
};`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([4]);
});

test("uses a shadowing list binding instead of an outer long list", async () => {
  const longList = Array.from(
    { length: 31 },
    (_, index) => `"zone-${index}"`,
  ).join(", ");
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
const options = [${longList}];
const ShortPicker = () => {
  const options = ["a", "b"];
  return <Select>{options.map((option) => <SelectItem value={option}>{option}</SelectItem>)}</Select>;
};`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts a list of exactly 30 explicit options", async () => {
  const options = Array.from(
    { length: 30 },
    (_, index) => `<SelectItem value="${index}">${index}</SelectItem>`,
  ).join("\n");
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}\nconst select = <Select>${options}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("rejects a long inline array mapped into a Select", async () => {
  const list = Array.from({ length: 31 }, (_, index) => `"zone-${index}"`).join(
    ", ",
  );
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}\nconst select = <Select>{[${list}].map((zone) => <SelectItem value={zone}>{zone}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([2]);
});

test("does not parse styles, default assets, or type-only imports as list sources", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
import "@/nonexistent-style.css";
import image from "./nonexistent-image.png";
import type { Option } from "./nonexistent-type";
const select = <Select><SelectItem value="one">One</SelectItem></Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("does not assume an array remains long after a bounded slice", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
import { COMMON_TIMEZONES } from "@/lib/timezones";
const twoZones = COMMON_TIMEZONES.slice(0, 2);
const shortOptions = () => COMMON_TIMEZONES.slice(0, 2);
const select = <Select>{twoZones.map((zone) => <SelectItem value={zone}>{zone}</SelectItem>)}</Select>;
const helperSelect = <Select>{shortOptions().map((zone) => <SelectItem value={zone}>{zone}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("does not treat a non-map call on a long-list helper as a mapped source", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
import { COMMON_TIMEZONES } from "@/lib/timezones";
const zoneOptions = () => COMMON_TIMEZONES;
const joined = <Select><SelectItem value="all">{zoneOptions().join(",")}</SelectItem></Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("treats a negative slice bound as still long", async () => {
  expect(
    await lintSingleRule(
      "searchable-long-select",
      `${IMPORTS}
import { COMMON_TIMEZONES } from "@/lib/timezones";
const mostZones = () => COMMON_TIMEZONES.slice(0, -1);
const select = <Select>{mostZones().map((zone) => <SelectItem value={zone}>{zone}</SelectItem>)}</Select>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([4]);
});
