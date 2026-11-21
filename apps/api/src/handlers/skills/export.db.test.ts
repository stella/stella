import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import { ZipArchive } from "@stll/docx-core/zip";
import {
  buildSkillPackage,
  SKILL_PACKAGE_MANIFEST_PATH,
} from "@stll/skills/package";
import type { SkillPackageFormat } from "@stll/skills/package";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills, auditLogs } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSkillExport } from "@/api/handlers/skills/export";
import { createUploadSkill } from "@/api/handlers/skills/upload";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import type { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

type Caller = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
};

const callerDb = ({ organizationId, userId, workspaceIds }: Caller): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, workspaceIds, organizationId, userId));

const BODY = [
  "Read `references/checklist.md`, then compare the draft with",
  "`references/precedent.pdf`.",
].join("\n");

type SeedOptions = {
  boundWorkspaceId?: SafeId<"workspace">;
  command?: string | null;
  resources?: { content: string; path: string }[];
  scope: "private" | "team";
  userId: SafeId<"user">;
};

const DEFAULT_RESOURCES = [
  { content: "- parties\n- term\n", path: "references/checklist.md" },
  // Text extracted from an uploaded PDF, stored at the PDF's path.
  {
    content: "# Precedent\n\nClause 4.2 ...\n",
    path: "references/precedent.pdf",
  },
];

const seedSkill = async ({
  boundWorkspaceId,
  command = null,
  resources = DEFAULT_RESOURCES,
  scope,
  userId,
}: SeedOptions) => {
  const id = testId<"agentSkill">();
  const slug = `export-${Bun.randomUUIDv7().slice(-10)}`;
  await testDb.insert(agentSkills).values({
    body: BODY,
    boundWorkspaceId: boundWorkspaceId ?? null,
    command,
    compatibility: "Needs the document reader.",
    contentHash: "0".repeat(64),
    description: "Review a contract against the firm checklist.",
    id,
    invocation: "manual",
    license: "Proprietary",
    metadata: { owner: "Contracts group" },
    name: "Contract review",
    organizationId: ids.orgA,
    origin: "authored",
    scope,
    slug,
    userId,
    version: "1.2.0",
  });
  const encoder = new TextEncoder();
  for (const resource of resources) {
    await testDb.insert(agentSkillResources).values({
      ...resource,
      organizationId: ids.orgA,
      sizeBytes: encoder.encode(resource.content).byteLength,
      skillId: id,
    });
  }
  return { id, slug };
};

type CapturedWrite = { data: Uint8Array; key: string };

/** Object storage standing in for the bucket: key to bytes. */
const objects = new Map<string, Uint8Array>();
const storeObject: typeof writeS3ObjectWithRetry = async ({ data, key }) => {
  objects.set(
    key,
    typeof data === "string" ? new TextEncoder().encode(data) : data,
  );
  return await Promise.resolve(S3_OBJECT_WRITE_CERTAINTY.CONFIRMED);
};
const readObject = async ({ key }: { key: string }): Promise<ArrayBuffer> => {
  const bytes = objects.get(key);
  if (bytes === undefined) {
    throw new TypeError(`no stored object at ${key}`);
  }
  return await Promise.resolve(Uint8Array.from(bytes).buffer);
};
const uploadSkill = createUploadSkill(storeObject);

const exportAs = async ({
  audit,
  caller,
  format,
  skillId,
}: {
  audit?: ReturnType<typeof createAuditRecorder>;
  caller: Caller;
  format: SkillPackageFormat;
  skillId: SafeId<"agentSkill">;
}) => {
  const writes: CapturedWrite[] = [];
  const events: AuditEvent[] = [];
  const handler = createSkillExport(async (object, ownership) => {
    if (!(object.data instanceof Uint8Array)) {
      throw new TypeError("the export stored no bytes");
    }
    writes.push({ data: object.data, key: object.key });
    return await storeObject(object, ownership);
  }, readObject);
  const response = await handler.handler(
    createTestHandlerContext<Parameters<typeof handler.handler>[0]>({
      audit:
        audit ??
        auditRecorderDouble((recorded) => {
          events.push(...recorded);
        }),
      memberRole: sessionMemberRole("member"),
      params: { skillId },
      query: { format },
      safeDb: callerDb(caller),
      scopedDb: NO_DB,
      session: { activeOrganizationId: caller.organizationId },
      user: { id: caller.userId },
    }),
  );
  return { events, response, writes };
};

const importAs = async (caller: Caller, file: File) =>
  await uploadSkill.handler(
    createTestHandlerContext<Parameters<typeof uploadSkill.handler>[0]>({
      audit: auditRecorderDouble(),
      body: { file, scope: "private" },
      memberRole: sessionMemberRole("member"),
      safeDb: callerDb(caller),
      scopedDb: NO_DB,
      session: { activeOrganizationId: caller.organizationId },
      user: { id: caller.userId },
    }),
  );

/** Everything that defines a stored skill, without its identity columns. */
const definitionOf = async (skillId: SafeId<"agentSkill">) => {
  const [skill] = await testDb
    .select({
      body: agentSkills.body,
      boundClientId: agentSkills.boundClientId,
      boundWorkspaceId: agentSkills.boundWorkspaceId,
      command: agentSkills.command,
      compatibility: agentSkills.compatibility,
      description: agentSkills.description,
      invocation: agentSkills.invocation,
      license: agentSkills.license,
      metadata: agentSkills.metadata,
      name: agentSkills.name,
      version: agentSkills.version,
    })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId));
  if (skill === undefined) {
    throw new TypeError(`no stored skill ${skillId}`);
  }
  const files = await testDb
    .select({
      content: agentSkillResources.content,
      path: agentSkillResources.path,
    })
    .from(agentSkillResources)
    .where(eq(agentSkillResources.skillId, skillId))
    .orderBy(asc(agentSkillResources.path));
  return { files, skill };
};

const owner: () => Caller = () => ({
  organizationId: ids.orgA,
  userId: ids.userA1,
  workspaceIds: [ids.wsA1],
});
const colleague: () => Caller = () => ({
  organizationId: ids.orgA,
  userId: ids.userA2,
  workspaceIds: [ids.wsA2],
});

const exportedBytes = async (
  skillId: SafeId<"agentSkill">,
  format: SkillPackageFormat,
) => {
  const { response, writes } = await exportAs({
    caller: owner(),
    format,
    skillId,
  });
  if ("code" in response) {
    throw new TypeError(`expected the export to succeed: ${response.code}`);
  }
  const [write] = writes;
  if (write === undefined) {
    throw new TypeError("expected one stored archive");
  }
  return { response, write };
};

describe("skill export", () => {
  test.each([
    { fileName: "contract-review.zip", format: "zip" },
    { fileName: "contract-review.skill", format: "skill" },
    // A .skill export renamed to .zip, and one saved without an extension.
    { fileName: "renamed.zip", format: "skill" },
    { fileName: "contract-review", format: "zip" },
  ] as const)(
    "a $format export imported as $fileName gives the identical definition and files",
    async ({ fileName, format }) => {
      const command = `review${Bun.randomUUIDv7().slice(-6)}`;
      const { id, slug } = await seedSkill({
        command,
        scope: "private",
        userId: ids.userA1,
      });
      const { response, write } = await exportedBytes(id, format);

      const imported = await importAs(
        colleague(),
        new File([write.data], fileName),
      );
      if ("code" in imported) {
        throw new TypeError(`expected the import to succeed: ${imported.code}`);
      }
      const original = await definitionOf(id);
      const copy = await definitionOf(toSafeId<"agentSkill">(imported.id));

      expect(response.fileName).toBe(`${slug}.${format}`);
      expect(write.key.startsWith(`exports/${ids.orgA}/skills/${id}/`)).toBe(
        true,
      );
      // The instructions name the file at the path the package gives it.
      expect(copy.skill).toEqual({
        ...original.skill,
        body: BODY.replace(
          "references/precedent.pdf",
          "references/precedent.md",
        ),
      });
      expect(copy.files).toEqual([
        ...original.files.slice(0, 1),
        // Extracted text travels as the Markdown it is.
        {
          content: "# Precedent\n\nClause 4.2 ...\n",
          path: "references/precedent.md",
        },
      ]);
    },
  );

  test("records one download audit row naming the skill and the format", async () => {
    const { id } = await seedSkill({ scope: "private", userId: ids.userA1 });
    const audit = createAuditRecorder({
      organizationId: ids.orgA,
      request: new Request("http://localhost/v1/skills/export"),
      server: null,
      userId: ids.userA1,
      workspaceId: null,
    });

    const { response } = await exportAs({
      audit,
      caller: owner(),
      format: "skill",
      skillId: id,
    });

    expect("code" in response).toBe(false);
    const rows = await testDb
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.AGENT_SKILL),
          eq(auditLogs.resourceId, id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AUDIT_ACTION.DOWNLOAD,
      metadata: { fileCount: 2, format: "skill" },
    });
  });

  test("extracted text whose Markdown name is taken goes to the first free name, and the instructions follow it", async () => {
    const { id } = await seedSkill({
      resources: [
        { content: "Report notes.\n", path: "references/report.md" },
        { content: "Older notes.\n", path: "references/report.pdf.md" },
        { content: "# Report\n", path: "references/report.pdf" },
      ],
      scope: "private",
      userId: ids.userA1,
    });
    await testDb
      .update(agentSkills)
      .set({
        body: "Read references/report.pdf. Then references/report.pdf.md and references/report.md.",
      })
      .where(eq(agentSkills.id, id));
    const { write } = await exportedBytes(id, "zip");

    const imported = await importAs(
      colleague(),
      new File([write.data], "report.zip"),
    );
    if ("code" in imported) {
      throw new TypeError(`expected the import to succeed: ${imported.code}`);
    }
    const copy = await definitionOf(toSafeId<"agentSkill">(imported.id));

    expect(copy.files).toHaveLength(3);
    expect(copy.files).toEqual(
      expect.arrayContaining([
        { content: "# Report\n", path: "references/report-2.md" },
        { content: "Report notes.\n", path: "references/report.md" },
        { content: "Older notes.\n", path: "references/report.pdf.md" },
      ]),
    );
    expect(copy.skill.body).toBe(
      "Read references/report-2.md. Then references/report.pdf.md and references/report.md.",
    );
  });

  test("a bound skill exports for a member who reaches it, without the binding", async () => {
    const { id } = await seedSkill({
      boundWorkspaceId: ids.wsA1,
      scope: "team",
      userId: ids.userAdmin,
    });
    const reached = await exportAs({
      caller: { ...colleague(), workspaceIds: [ids.wsA1] },
      format: "zip",
      skillId: id,
    });
    expect(reached.response).toMatchObject({ format: "zip" });
    expect("downloadUrl" in reached.response).toBe(true);
    const [write] = reached.writes;
    if (write === undefined) {
      throw new TypeError("expected one stored archive");
    }
    const archive = await ZipArchive.read(write.data);
    const manifest = await archive
      .entries()
      .find(({ path }) => path.endsWith(SKILL_PACKAGE_MANIFEST_PATH))
      ?.text();

    expect(manifest).toBeDefined();
    expect(manifest).not.toContain(ids.wsA1);
    const imported = await importAs(
      colleague(),
      new File([write.data], "b.zip"),
    );
    if ("code" in imported) {
      throw new TypeError("expected the import to succeed");
    }
    expect(
      (await definitionOf(toSafeId<"agentSkill">(imported.id))).skill,
    ).toMatchObject({ boundClientId: null, boundWorkspaceId: null });
  });

  test.each([
    {
      case: "another member's private skill",
      caller: colleague,
      seed: async () =>
        await seedSkill({ scope: "private", userId: ids.userA1 }),
    },
    {
      case: "a skill bound to a matter the caller does not reach",
      caller: colleague,
      seed: async () =>
        await seedSkill({
          boundWorkspaceId: ids.wsA1,
          scope: "team",
          userId: ids.userAdmin,
        }),
    },
    {
      case: "another organization's skill",
      caller: (): Caller => ({
        organizationId: ids.orgB,
        userId: ids.userB1,
        workspaceIds: [ids.wsB1],
      }),
      seed: async () =>
        await seedSkill({ scope: "team", userId: ids.userAdmin }),
    },
  ])("$case is not found and nothing is stored or audited", async (row) => {
    const { id } = await row.seed();

    const { events, response, writes } = await exportAs({
      caller: row.caller(),
      format: "zip",
      skillId: id,
    });

    expect(response).toMatchObject({ code: 404 });
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("skill export with stored originals", () => {
  // The 8-byte PNG signature and an IHDR chunk header: no text in it.
  const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);

  const originalKey = async (skillId: SafeId<"agentSkill">) => {
    const [row] = await testDb
      .select({ key: agentSkillResources.originalS3Key })
      .from(agentSkillResources)
      .where(
        and(
          eq(agentSkillResources.skillId, skillId),
          eq(agentSkillResources.path, "assets/logo.png"),
        ),
      );
    return row?.key ?? undefined;
  };

  /** A skill imported from a package holding one binary file. */
  const importedWithLogo = async () => {
    const slug = `originals-${Bun.randomUUIDv7().slice(-10)}`;
    const zip = new ZipArchive();
    for (const entry of buildSkillPackage({
      command: null,
      displayName: "Brand review",
      resources: [{ bytes: PNG_BYTES, path: "assets/logo.png" }],
      skillMd: `---\nname: "${slug}"\ndescription: "Originals export test."\n---\n\nUse \`assets/logo.png\`.\n`,
      slug,
    })) {
      zip.set(entry.path, entry.bytes);
    }
    const installed = await importAs(
      owner(),
      new File([(await zip.generate()).buffer], `${slug}.zip`),
    );
    if ("code" in installed) {
      throw new TypeError(`expected the import to succeed: ${installed.code}`);
    }
    return { skillId: toSafeId<"agentSkill">(installed.id), slug };
  };

  test("a file kept with its original exports byte for byte and imports again", async () => {
    const { skillId, slug } = await importedWithLogo();
    const key = await originalKey(skillId);
    expect(key === undefined ? undefined : objects.get(key)).toEqual(PNG_BYTES);

    const { write } = await exportedBytes(skillId, "skill");
    const archive = await ZipArchive.read(write.data);
    const exported = await archive
      .entries()
      .find(({ path }) => path === `${slug}/assets/logo.png`)
      ?.bytes();
    const imported = await importAs(
      colleague(),
      new File([write.data], "b.skill"),
    );
    if ("code" in imported) {
      throw new TypeError(`expected the import to succeed: ${imported.code}`);
    }
    const copyKey = await originalKey(toSafeId<"agentSkill">(imported.id));

    expect(exported).toEqual(PNG_BYTES);
    expect(copyKey === undefined ? undefined : objects.get(copyKey)).toEqual(
      PNG_BYTES,
    );
  });

  test("an original that no longer matches its record fails the export", async () => {
    const { skillId } = await importedWithLogo();
    const key = await originalKey(skillId);
    if (key === undefined) {
      throw new TypeError("expected a stored original");
    }
    objects.set(key, Uint8Array.from([...PNG_BYTES, 0x00]));

    const { events, response, writes } = await exportAs({
      caller: owner(),
      format: "zip",
      skillId,
    });

    expect(response).toMatchObject({ code: 500 });
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
  });
});
