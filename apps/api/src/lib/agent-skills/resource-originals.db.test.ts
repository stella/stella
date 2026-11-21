import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { arrayOverlaps, eq } from "drizzle-orm";

import { ZipArchive } from "@stll/docx-core/zip";
import { sha256Hex } from "@stll/sha256/bun";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/format";
import {
  buildSkillPackage,
  type SkillArchiveEntry,
} from "@stll/skills/package";

import type { SafeDb } from "@/api/db/safe-db";
import {
  agentSkillOriginalCleanupRequests,
  agentSkillResources,
  agentSkills,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createUploadSkillResource } from "@/api/handlers/skills/resources/upload";
import { readSkillResourceOriginals } from "@/api/lib/agent-skills/resource-originals";
import type { SafeId } from "@/api/lib/branded-types";
import { SKILL_PACKAGE_SIZE_CONSTRAINT } from "@/api/lib/db/constraint-refusals";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import type { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import { createCleanAgentSkillOriginalObjects } from "@/api/lib/scheduler/tasks/agent-skill-original-cleanup";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { installSkill } from "@/api/lib/skills/install";
import { parseUploadedSkillPackage } from "@/api/lib/skills/skill-package";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
});

afterAll(async () => {
  await releaseRlsFixture();
});

const memberSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

/** Object storage standing in for the bucket: key to bytes. */
const fakeStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const writeObject: typeof writeS3ObjectWithRetry = async ({ data, key }) => {
    objects.set(
      key,
      typeof data === "string" ? new TextEncoder().encode(data) : data,
    );
    return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
  };
  return { objects, writeObject };
};

// The 8-byte PNG signature and an IHDR chunk header: no text in it.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

const SKILL_MD = (slug: string) =>
  `---\nname: "${slug}"\ndescription: "Originals test."\n---\n\nUse \`assets/logo.png\`.\n`;

const installPackage = async ({
  edit = (entries) => entries,
  writeObject,
}: {
  edit?: (entries: SkillArchiveEntry[]) => SkillArchiveEntry[];
  writeObject: typeof writeS3ObjectWithRetry;
}) => {
  const slug = `originals-${Bun.randomUUIDv7().slice(-8)}`;
  const zip = new ZipArchive();
  for (const entry of edit(
    buildSkillPackage({
      command: null,
      displayName: "Originals test",
      resources: [{ bytes: PNG_BYTES, path: "assets/logo.png" }],
      skillMd: SKILL_MD(slug),
      slug,
    }),
  )) {
    zip.set(entry.path, entry.bytes);
  }
  const parsed = await parseUploadedSkillPackage(
    testScannedFile({
      bytes: (await zip.generate()).buffer,
      mimeType: "application/zip",
      path: `${slug}.skill`,
    }),
  );
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }
  const installed = await installSkill({
    binaryFiles: parsed.value.binaryFiles,
    memberRole: sessionMemberRole("member"),
    onSlugTaken: "copy",
    origin: "upload",
    parsed: parsed.value,
    recordAuditEvent: auditRecorderDouble(),
    safeDb: memberSafeDb(),
    scope: "private",
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    writeObject,
  });
  return Result.isError(installed)
    ? Result.err(installed.error)
    : Result.ok({ skillId: installed.value.id, slug });
};

const installedSkill = async (
  writeObject: typeof writeS3ObjectWithRetry,
): Promise<SafeId<"agentSkill">> => {
  const installed = await installPackage({ writeObject });
  if (Result.isError(installed)) {
    throw installed.error;
  }
  return installed.value.skillId;
};

const originalsOf = async (skillId: SafeId<"agentSkill">) =>
  await testDb.transaction(
    async (tx) => await readSkillResourceOriginals(asTestRaw(tx), skillId),
  );

const queuedKeys = async (keys: readonly string[]) =>
  (
    await testDb
      .select({ s3Keys: agentSkillOriginalCleanupRequests.s3Keys })
      .from(agentSkillOriginalCleanupRequests)
      .where(arrayOverlaps(agentSkillOriginalCleanupRequests.s3Keys, [...keys]))
  ).flatMap(({ s3Keys }) => s3Keys);

describe("skill file originals", () => {
  test("a package import keeps a binary file byte for byte, hash and size matching", async () => {
    const storage = fakeStorage();
    const skillId = await installedSkill(storage.writeObject);

    const original =
      (await originalsOf(skillId)).get("assets/logo.png") ??
      panic("expected the binary file's original");
    const [row] = await testDb
      .select({ content: agentSkillResources.content })
      .from(agentSkillResources)
      .where(eq(agentSkillResources.originalS3Key, original.s3Key));

    expect(original).toMatchObject({
      mediaType: "image/png",
      sha256: sha256Hex(PNG_BYTES),
      sizeBytes: PNG_BYTES.byteLength,
    });
    expect(
      original.s3Key.startsWith(`${ids.orgA}/agent-skills/originals/`),
    ).toBe(true);
    expect(storage.objects.get(original.s3Key)).toEqual(PNG_BYTES);
    expect(row?.content).toContain("is a binary file (image/png");
  });

  test("a binary file changed after export refuses the package and stores nothing", async () => {
    const storage = fakeStorage();
    const result = await installPackage({
      edit: (entries) =>
        entries.map((entry) =>
          entry.path.endsWith("assets/logo.png")
            ? { ...entry, bytes: Uint8Array.from([...PNG_BYTES, 0x00]) }
            : entry,
        ),
      writeObject: storage.writeObject,
    });

    expect(Result.isError(result) && result.error).toMatchObject({
      code: "skill_package_file_changed",
    });
    expect(storage.objects.size).toBe(0);
  });

  test("an uploaded file with no text keeps its bytes as the original", async () => {
    const storage = fakeStorage();
    const skillId = await installedSkill(storage.writeObject);
    const upload = createUploadSkillResource(storage.writeObject);

    const result = await upload.handler(
      createTestHandlerContext<Parameters<typeof upload.handler>[0]>({
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        memberRole: sessionMemberRole("member"),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: memberSafeDb(),
        body: {
          file: new File([PNG_BYTES], "seal.png", { type: "image/png" }),
          path: "assets/seal.png",
        },
        params: { skillId },
      }),
    );

    expect("code" in result).toBe(false);
    const original =
      (await originalsOf(skillId)).get("assets/seal.png") ??
      panic("expected the upload's original");
    expect(original.sha256).toBe(sha256Hex(PNG_BYTES));
    expect(original.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(storage.objects.get(original.s3Key)).toEqual(PNG_BYTES);
  });

  test("new text for a file drops its original and queues it for erasure", async () => {
    const storage = fakeStorage();
    const skillId = await installedSkill(storage.writeObject);
    const original =
      (await originalsOf(skillId)).get("assets/logo.png") ??
      panic("expected the original");

    await testDb
      .update(agentSkillResources)
      .set({ content: "Now a text file." })
      .where(eq(agentSkillResources.originalS3Key, original.s3Key));

    expect((await originalsOf(skillId)).has("assets/logo.png")).toBe(false);
    expect(await queuedKeys([original.s3Key])).toEqual([original.s3Key]);
  });

  test("deleting a skill queues every original, and the cleanup erases them and forgets the request", async () => {
    const storage = fakeStorage();
    const skillId = await installedSkill(storage.writeObject);
    const original =
      (await originalsOf(skillId)).get("assets/logo.png") ??
      panic("expected the original");

    await testDb.delete(agentSkills).where(eq(agentSkills.id, skillId));
    expect(await queuedKeys([original.s3Key])).toEqual([original.s3Key]);

    const erased: string[] = [];
    const cleanup = createCleanAgentSkillOriginalObjects(async (keys) => {
      erased.push(...keys);
      return Result.ok();
    });
    await cleanup(
      asTestRaw<SchedulerTaskContext>({
        db: testDb,
        logger: {
          error: () => undefined,
          info: () => undefined,
          warn: () => undefined,
        },
        signal: new AbortController().signal,
      }),
    );

    expect(erased).toContain(original.s3Key);
    expect(await queuedKeys([original.s3Key])).toEqual([]);
  });

  test("the package size limit counts an original's bytes", async () => {
    const storage = fakeStorage();
    const skillId = await installedSkill(storage.writeObject);
    const write = await Result.tryPromise(
      async () =>
        await testDb.insert(agentSkillResources).values({
          content: "x",
          organizationId: ids.orgA,
          originalMediaType: "application/octet-stream",
          originalS3Key: `${ids.orgA}/agent-skills/originals/${Bun.randomUUIDv7()}`,
          originalSha256: "0".repeat(64),
          originalSizeBytes: SKILL_PACKAGE_LIMITS.packageFilesMaxBytes,
          path: "assets/large.bin",
          sizeBytes: 1,
          skillId,
        }),
    );

    expect(
      Result.isError(write) &&
        isPgConstraintError(
          write.error,
          PG_ERROR.CHECK_VIOLATION,
          SKILL_PACKAGE_SIZE_CONSTRAINT,
        ),
    ).toBe(true);
  });
});
