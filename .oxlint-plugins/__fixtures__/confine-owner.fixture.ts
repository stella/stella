// Passive regression fixture for `confine-owner/confine-owner`.
//
// This file appears in no ownership entry's `allowed` list, so every use of an
// owned capability here must be rejected. Each `oxlint-disable-next-line`
// suppresses a case the rule MUST flag: if the rule regresses, the directive
// goes unused and `--report-unused-disable-directives-severity=error` fails.

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves an aliased import of an owned binding is rejected
import { compileLegalSourceToDocx as compile } from "@stll/docx-core";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a named import of an owned binding is rejected
import { createDocx } from "@stll/folio-core";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a namespace import reaches every owned binding and is rejected
import * as folio from "@stll/folio-core/server";
// Accepted: a sibling export of the same entry point is not an owned binding.
import { paragraph } from "@stll/folio-core/server";

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a static import of an owned module is rejected
import { createRedisClient } from "@/api/lib/redis-client";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a type-only import still opens the owned surface and is rejected
import type { createBullMqConnection } from "@/api/lib/redis-client";

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a facade re-exporting an owned binding is rejected
export { createDocx as serialize } from "@stll/folio-core/server";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a star re-export reaches every owned binding and is rejected
export * from "@stll/docx-core";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a re-export of a whole owned module is rejected
export { createRedisClient as client } from "@/api/lib/redis-client";
// Accepted: a facade over a sibling export does not hand out the capability.
export { heading } from "@stll/folio-core/server";

declare const navigator: {
  clipboard: {
    readText: () => Promise<string>;
    writeText: (text: string) => Promise<void>;
  };
};
declare const window: {
  navigator: { clipboard: { writeText: (text: string) => Promise<void> } };
};

const loadConnection = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a dynamic import of an owned module is rejected
  await import("@/api/lib/redis-client");

export const copyDirectly = async (text: string) => {
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a direct clipboard write is rejected
  await navigator.clipboard.writeText(text);
};

export const copyThroughWindow = async (text: string) => {
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves the `window.` spelling of the global is rejected
  await window.navigator.clipboard.writeText(text);
};

// Accepted: reading the clipboard is a different capability, so the sibling
// member of the same object carries no directive and must not be reported.
export const pasteDirectly = async () => await navigator.clipboard.readText();

// Accepted: an unrelated member access that shares neither half of the pair.
export const readTitle = (page: { clipboard: string }) => page.clipboard;

void loadConnection;
void createRedisClient;
void createDocx;
void compile;
void folio;
void paragraph;
type _Connection = typeof createBullMqConnection;
