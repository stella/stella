import { readFileSync } from "node:fs";
import nodePath from "node:path";

/** The migrate bundle keeps this directory beside the shipped drizzle tree. */
export const readMatterVisibilityCutoverSql = () =>
  readFileSync(
    nodePath.resolve(
      import.meta.dir,
      "../../drizzle/20261029072000_matter_visibility/cutover.sql",
    ),
    "utf-8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
