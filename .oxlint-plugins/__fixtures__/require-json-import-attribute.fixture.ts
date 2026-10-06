// oxlint-disable-next-line require-json-import-attribute/require-json-import-attribute
import bare from "./fixture-1.json";
// oxlint-disable-next-line require-json-import-attribute/require-json-import-attribute
import * as namespace from "./fixture-3.json";
// oxlint-disable-next-line require-json-import-attribute/require-json-import-attribute
import "./fixture-2.json";
// oxlint-disable-next-line require-json-import-attribute/require-json-import-attribute
import wrong from "./fixture-4.json" with { type: "text" };
// expect-clean: require-json-import-attribute/require-json-import-attribute
import valid from "./fixture-5.json" with { type: "json" };
// expect-clean: require-json-import-attribute/require-json-import-attribute
import quoted from "./fixture-6.json" with { type: "json" };
// expect-clean: require-json-import-attribute/require-json-import-attribute
import type { Example } from "./fixture-7.json";
// expect-clean: require-json-import-attribute/require-json-import-attribute
import ordinary from "./fixture.js";

export { bare, namespace, wrong, valid, quoted, ordinary };
export type { Example };
