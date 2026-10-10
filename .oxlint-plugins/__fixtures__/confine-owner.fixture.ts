// Passive regression fixture for `confine-owner/confine-owner`.
//
// This file appears in no ownership entry's `allowed` list, so every use of an
// owned capability here must be rejected. Each `oxlint-disable-next-line`
// suppresses a case the rule MUST flag: if the rule regresses, the directive
// goes unused and `--report-unused-disable-directives-severity=error` fails.

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a subpath of an owned package is the same package
import { chat as runChat } from "@tanstack/ai/chat";
// Accepted: an unrelated export of the owned package's subpath.
// expect-clean: confine-owner/confine-owner
import { toolDefinition } from "@tanstack/ai/tools";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves the worker primitive is confined even through an import alias
import { Queue, Worker as RawQueueWorker } from "bullmq";

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves an aliased import of an owned binding is rejected
import { compileLegalSourceToDocx as compile } from "@stll/docx-core";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a named import of an owned binding is rejected
import { createDocx } from "@stll/folio-core";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a namespace import reaches every owned binding and is rejected
import * as folio from "@stll/folio-core/server";
// Accepted: a sibling export of the same entry point is not an owned binding.
// expect-clean: confine-owner/confine-owner
import { paragraph } from "@stll/folio-core/server";

import { auditLogs } from "@/api/db/schema";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a static import of an owned module is rejected
import { createRedisClient } from "@/api/lib/redis-client";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a type-only import still opens the owned surface and is rejected
import type { createBullMqConnection } from "@/api/lib/redis-client";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a pinned workspace handle is built only by its listed modules
import { createRootSafeDb } from "@/api/lib/root-scoped-db";

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a relative specifier resolves to the owned module
import { createRedisClient as relativeClient } from "../../apps/api/src/lib/redis-client.ts";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a run actor is built only by a listed member-run queue
import { createRootRunActor } from "../../apps/api/src/lib/root-scoped-db.ts";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a deep relative import of an owned package source file is rejected
import { countryCodeFromAlpha3 } from "../../packages/country-codes/src/alpha3.ts";

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a raw audit change selection is confined to its projection owner
export const rawAuditSelection = { changes: auditLogs.changes };
// expect-clean: confine-owner/confine-owner
export const auditIdentitySelection = { id: auditLogs.id };

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a facade re-exporting an owned binding is rejected
export { createDocx as serialize } from "@stll/folio-core/server";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a star re-export reaches every owned binding and is rejected
export * from "@stll/docx-core";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a re-export of a whole owned module is rejected
export { createRedisClient as client } from "@/api/lib/redis-client";
// Accepted: a facade over a sibling export does not hand out the capability.
// expect-clean: confine-owner/confine-owner
export { heading } from "@stll/folio-core/server";

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a named stored-reader re-export is confined
export { readS3ArrayBuffer as readStoredBytes } from "@/api/lib/s3";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a star stored-reader re-export is confined
export * from "@/api/lib/s3";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a named tenant-reader re-export is confined
export { readTenantS3ArrayBuffer as readTenantBytes } from "@/api/lib/s3-presign";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a named signer re-export is confined
export { presignDownloadUrl as signStoredBytes } from "@/api/lib/s3-presign";
// oxlint-disable-next-line confine-owner/confine-owner -- x2: star re-export reaches the tenant reader and signer
export * from "@/api/lib/s3-presign";

export const loadStoredReaders = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a dynamic stored-reader import is confined
  await import("@/api/lib/s3");

export const loadTenantReadersAndSigner = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- x2: dynamic import reaches the tenant reader and signer
  await import("@/api/lib/s3-presign");

export const loadTenantReader = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a dynamic tenant-reader member is confined
  (await import("@/api/lib/s3-presign")).readTenantS3ArrayBuffer;

export const loadStoredSigner = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a dynamic signer member is confined
  (await import("@/api/lib/s3-presign")).presignDownloadUrl;

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

const loadSerializer = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a dynamic import of a name-confined entry point reaches every owned binding and is rejected
  await import("@stll/folio-core");

export const destructureOwned = async () => {
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves destructuring an owned binding from a dynamic import is rejected
  const { createDocx: build } = await import("@stll/folio-core");
  return build;
};

export const readOwnedMember = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves reading an owned binding off a dynamic import is rejected
  (await import("@stll/folio-core/server")).createDocx;

export const destructureWithRest = async () => {
  const { paragraph: _paragraph, ...rest } =
    // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a rest element reaches every owned binding and is rejected
    await import("@stll/folio-core/server");
  return rest;
};

// Accepted: a sibling export destructured from a dynamic import of the entry
// point is not an owned binding.
export const destructureSibling = async () => {
  // expect-clean: confine-owner/confine-owner
  const { paragraph: buildParagraph } = await import("@stll/folio-core/server");
  return buildParagraph;
};

// Accepted: a sibling export read off a dynamic import.
export const readSiblingMember = async () =>
  // expect-clean: confine-owner/confine-owner
  (await import("@stll/folio-core/server")).heading;

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
void loadSerializer;
void createRedisClient;
void createDocx;
void compile;
void folio;
void paragraph;
void RawQueueWorker;
void Queue;
void runChat;
void toolDefinition;
void relativeClient;
void countryCodeFromAlpha3;
void createRootSafeDb;
void createRootRunActor;
type _Connection = typeof createBullMqConnection;
