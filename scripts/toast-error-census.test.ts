import { expect, test } from "bun:test";

import { inspectToastSource } from "./toast-error-census";

const importedToast = `import { stellaToast as notice } from "@stll/ui/toast";`;

test("the census enumerates every error-capable API and exported error options", () => {
  const entries = inspectToastSource(`${importedToast}
    notice.error(reason);
    notice.add({ title: reason, type: status });
    notice.update(id, { title: reason, type: status });
    notice.promise(request, { error: () => reason });
    export const options = { type: "error", title: reason };
    notice.success("Saved");
  `);
  expect(entries.map(({ kind }) => kind)).toEqual([
    "error",
    "add",
    "update",
    "promise",
    "error-options",
  ]);
  expect(entries.every(({ truncating }) => !truncating)).toBe(true);
});

test.each([
  "truncate",
  "line-clamp-2",
  "text-ellipsis",
  "whitespace-nowrap",
  "overflow-hidden",
  "md:truncate",
])("a planted error toast using %s fails the census", (className) => {
  const entries = inspectToastSource(`${importedToast}
      const title = <span className="${className}">{providerReason}</span>;
      const options = { title, type: "error" };
      notice.add(options);
    `);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every(({ truncating }) => truncating)).toBe(true);
});

test("a planted promise error callback and truncating inline style fail", () => {
  const entries = inspectToastSource(`${importedToast}
    notice.promise(request, {
      error: () => <span style={{ textOverflow: "ellipsis" }}>{reason}</span>,
    });
  `);
  expect(entries).toMatchObject([{ kind: "promise", truncating: true }]);
});

test("wrapping full error text passes", () => {
  const entries = inspectToastSource(`${importedToast}
    const title = <span className="whitespace-pre-wrap wrap-anywhere">{reason}</span>;
    notice.error(title);
  `);
  expect(entries).toMatchObject([{ kind: "error", truncating: false }]);
});

test("error wrapper aliases are enumerated and reject a truncating fallback", () => {
  const entries = inspectToastSource(`
    import { notifyUserError as report } from "@/lib/errors/user-toast";
    report(error, <span className="truncate">{reason}</span>);
  `);
  expect(entries).toMatchObject([{ kind: "error-wrapper", truncating: true }]);
});

test("request callbacks and error data never become rendered toast text", () => {
  const entries = inspectToastSource(`${importedToast}
    import { notifyUserError } from "@/lib/errors/user-toast";
    const request = () => <span className="truncate">unrelated page</span>;
    const result = request();
    notice.promise(request(), { error: () => "Full error", loading: "Loading", success: "Saved" });
    notifyUserError(result.error, "Full fallback");
    notice.add({ title: "Full error", type: "error", data: { request } });
    notice.update(id, { title: "Full error", type: "error", data: { request } });
  `);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every(({ truncating }) => !truncating)).toBe(true);
});

test("exported shorthand error text is covered without a local toast call", () => {
  const entries = inspectToastSource(`
    const title = <span className="truncate">{reason}</span>;
    export const options = { type: "error", title };
  `);
  expect(entries).toMatchObject([{ kind: "error-options", truncating: true }]);
});
