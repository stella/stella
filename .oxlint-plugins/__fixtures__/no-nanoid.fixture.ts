/* oxlint-disable import/no-duplicates, unicorn/prefer-module -- fixture: each import form stands on its own line */

// Passive regression fixture for `no-nanoid/no-nanoid`: every load of the
// removed dependency is reported once, however it is written.

// oxlint-disable-next-line no-nanoid/no-nanoid -- side-effect import
import "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- aliased named import
import { nanoid as makeId } from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- type-only import still names the removed package
import type { nanoid as NanoidFn } from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- namespace import
import * as Nanoid from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- subpath import
import { customAlphabet } from "nanoid/non-secure";
// expect-clean: no-nanoid/no-nanoid
import { randomUUID } from "node:crypto";

// oxlint-disable-next-line no-nanoid/no-nanoid -- require
const requiredModule = require("nanoid");
// oxlint-disable-next-line no-nanoid/no-nanoid -- require member
const requiredMember = require("nanoid").nanoid;
// oxlint-disable-next-line no-nanoid/no-nanoid -- awaited dynamic import with destructuring
const { nanoid: loadedNanoid } = await import("nanoid");
// oxlint-disable-next-line no-nanoid/no-nanoid -- dynamic import
const pendingModule = import("nanoid/async");

// oxlint-disable-next-line no-nanoid/no-nanoid -- named re-export
export { nanoid as reexportedNanoid } from "nanoid";
// oxlint-disable-next-line no-nanoid/no-nanoid -- star re-export
export * from "nanoid/non-secure";

// expect-clean: no-nanoid/no-nanoid
const generatedId = Bun.randomUUIDv7();
const randomBytes = crypto.getRandomValues(new Uint8Array(16));
const typedId: ReturnType<typeof NanoidFn> = makeId();

export {
  customAlphabet,
  generatedId,
  loadedNanoid,
  Nanoid,
  pendingModule,
  randomBytes,
  randomUUID,
  requiredMember,
  requiredModule,
  typedId,
};
