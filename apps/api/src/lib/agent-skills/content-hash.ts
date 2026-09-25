import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * `agent_skills.content_hash` identifies everything a skill row installs: its
 * frontmatter fields, its body, and every resource file. URL imports compare
 * it to decide whether a re-import changes nothing, so every write to any of
 * these must store the hash this module computes; a path that forgets would
 * let a locally edited skill pass for the unchanged upstream package.
 */

type SkillResourceDigest = { path: string; contentSha256: string };

type SkillContentFields = {
  body: string;
  compatibility: string | null;
  description: string;
  license: string | null;
  metadata: Record<string, string>;
  name: string;
  version: string | null;
};

type SkillContent = SkillContentFields & {
  resources: readonly SkillResourceDigest[];
};

const CONTENT_HASH_FORMAT = "stella-skill-content-v1";
const UTF8_ENCODER = new TextEncoder();

const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};

export const sha256Hex = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

export const hashSkillContent = (content: SkillContent): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  // Length-prefixed fields: no two distinct contents share a byte stream.
  const field = (value: string) => {
    const bytes = UTF8_ENCODER.encode(value);
    hasher.update(`${bytes.byteLength}:`);
    hasher.update(bytes);
  };
  const optionalField = (value: string | null) => {
    field(value === null ? "absent" : "present");
    field(value ?? "");
  };

  field(CONTENT_HASH_FORMAT);
  field(content.name);
  field(content.description);
  optionalField(content.version);
  optionalField(content.license);
  optionalField(content.compatibility);
  const metadata = Object.entries(content.metadata).toSorted(([a], [b]) =>
    compareCodeUnits(a, b),
  );
  field(String(metadata.length));
  for (const [key, value] of metadata) {
    field(key);
    field(value);
  }
  field(content.body);
  const resources = content.resources.toSorted((a, b) =>
    compareCodeUnits(a.path, b.path),
  );
  field(String(resources.length));
  for (const resource of resources) {
    field(resource.path);
    field(resource.contentSha256);
  }
  return hasher.digest("hex");
};

/** Hash of a skill about to be installed from its parsed files. */
export const hashSkillPackageContent = ({
  resources,
  ...fields
}: SkillContentFields & {
  resources: readonly { content: string; path: string }[];
}): string =>
  hashSkillContent({
    ...fields,
    resources: resources.map(({ content, path }) => ({
      contentSha256: sha256Hex(content),
      path,
    })),
  });

type SkillContentHashAfterOptions = {
  skillId: SafeId<"agentSkill">;
  patch?: Partial<SkillContentFields>;
};

/**
 * Hash of a stored skill with `patch` applied, from the rows this transaction
 * sees. Locks the skill row so concurrent writes to the skill or its resources
 * each hash the state they leave behind.
 */
export const skillContentHashAfter = async (
  tx: Transaction,
  { skillId, patch = {} }: SkillContentHashAfterOptions,
): Promise<string> => {
  const skillRows = await tx
    .select({
      body: agentSkills.body,
      compatibility: agentSkills.compatibility,
      description: agentSkills.description,
      license: agentSkills.license,
      metadata: agentSkills.metadata,
      name: agentSkills.name,
      version: agentSkills.version,
    })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .limit(1)
    .for("update");
  const skill = skillRows.at(0);
  if (skill === undefined) {
    return panic("skill vanished while its content hash was computed");
  }
  // Bounded by the per-skill resource cap. Hashed in the database so a hash
  // never pulls every resource body into the API process.
  const resources = await tx
    .select({
      path: agentSkillResources.path,
      contentSha256: sql<string>`encode(sha256(convert_to(${agentSkillResources.content}, 'UTF8')), 'hex')`,
    })
    .from(agentSkillResources)
    .where(eq(agentSkillResources.skillId, skillId));

  return hashSkillContent({ ...skill, ...patch, resources });
};

const LOCKED_SKILL: unique symbol = Symbol("stella.lockedSkill");

/** Proof that the transaction holds the skill row lock. */
export type LockedSkill = {
  readonly [LOCKED_SKILL]: true;
  readonly skillId: SafeId<"agentSkill">;
};

/**
 * Lock a skill row before writing its resources. Inserting a resource takes a
 * key-share lock on the skill through its foreign key, so two concurrent
 * inserts that locked the skill only afterwards would each hold that lock and
 * deadlock upgrading it.
 */
export const lockSkillForResourceWrite = async (
  tx: Transaction,
  skillId: SafeId<"agentSkill">,
): Promise<LockedSkill> => {
  await tx
    .select({ id: agentSkills.id })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .for("update");
  return { [LOCKED_SKILL]: true, skillId };
};

/** Store the content hash after a write to a skill's resources. */
export const refreshSkillContentHash = async (
  tx: Transaction,
  { skillId }: LockedSkill,
): Promise<void> => {
  const contentHash = await skillContentHashAfter(tx, { skillId });
  await tx
    .update(agentSkills)
    .set({ contentHash })
    .where(eq(agentSkills.id, skillId));
};
