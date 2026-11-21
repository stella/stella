// expect-error-fixture
export const fixture = String.raw`
import { fileURLToPath } from "node:url";

declare const file: string;

// expect-error: no-module-url-pathname/no-module-url-pathname
const fixturesDirectory = new URL("../fixtures", import.meta.url).pathname;
// expect-error: no-module-url-pathname/no-module-url-pathname
const ownFile = new URL(import.meta.url).pathname;
// expect-error: no-module-url-pathname/no-module-url-pathname
const resolvedPackage = new URL(import.meta.resolve("@stll/scripts")).pathname;
// expect-error: no-module-url-pathname/no-module-url-pathname
const { pathname: destructured } = new URL(".", import.meta.url);
const moduleDirectory = new URL(".", import.meta.url);
// expect-error: no-module-url-pathname/no-module-url-pathname
const boundUrl = moduleDirectory.pathname;
// expect-error: no-module-url-pathname/no-module-url-pathname
const nestedBase = new URL(file, moduleDirectory).pathname;
// expect-error: no-module-url-pathname/no-module-url-pathname
const hrefBase = new URL(file, moduleDirectory.href).pathname;
// expect-error: no-module-url-pathname/no-module-url-pathname
const computedKey = new URL(file, import.meta.url)["pathname"];
// expect-error: no-module-url-pathname/no-module-url-pathname
const decoded = decodeURIComponent(new URL(file, import.meta.url).pathname);
// expect-error: no-module-url-pathname/no-module-url-pathname
const strippedString = import.meta.url.replace("file://", "");
// expect-error: no-module-url-pathname/no-module-url-pathname
const strippedRegex = import.meta.url.replace(/^file:\/\//u, "");
// expect-error: no-module-url-pathname/no-module-url-pathname
const slicedHref = moduleDirectory.href.slice(7);

// expect-clean: no-module-url-pathname/no-module-url-pathname
const converted = fileURLToPath(new URL("../fixtures", import.meta.url));
// expect-clean: no-module-url-pathname/no-module-url-pathname
const ownDirectory = import.meta.dirname;
// expect-clean: no-module-url-pathname/no-module-url-pathname
const absoluteInput = new URL("https://example.test/a", import.meta.url).pathname;
// expect-clean: no-module-url-pathname/no-module-url-pathname
const webUrl = new URL("/a", "https://example.test").pathname;
// expect-clean: no-module-url-pathname/no-module-url-pathname
const unrelatedSlice = import.meta.url.slice(0, 4);
// expect-clean: no-module-url-pathname/no-module-url-pathname
moduleDirectory.pathname = "/elsewhere/";

void [fixturesDirectory, ownFile, resolvedPackage, destructured, boundUrl, nestedBase, hrefBase, computedKey, decoded, strippedString, strippedRegex, slicedHref, converted, ownDirectory, absoluteInput, webUrl, unrelatedSlice];
`;
