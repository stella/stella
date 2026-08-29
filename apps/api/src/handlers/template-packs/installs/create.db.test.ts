/**
 * Install is an identity operation, not just a copy: a second install of the
 * same pack template must not add a second copy, and the copy it does make
 * must carry the pack, version, slug and content hash it came from. The
 * handler's pre-read and a partial unique index guard the same invariant, so
 * this runs against a real database with the real index in place; only the
 * DOCX-and-S3 write itself is stubbed.
 */

import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import { createTemplatePackCatalogue } from "@stll/template-packs";
import { createFixtureTemplatePackCatalogue } from "@stll/template-packs/fixtures";
import type { GeneratedTemplatePack } from "@stll/template-packs/schema";

import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import type { TemplateOrigin } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CreateStoredTemplateOptions } from "@/api/lib/templates/create-template";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import type { installTemplatePackHandler as InstallTemplatePackHandler } from "./create";

setDefaultTimeout(120_000);

const PACK_ID = "sample-pack";
const INSTALLED_SLUG = "employment-agreement";
/** A second entry over the same fixture DOCX: one installed, one not. */
const NEW_SLUG = "employment-agreement-short";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let otherOrgSafeDb: SafeDb;
let installTemplatePackHandler: typeof InstallTemplatePackHandler;

const createdOrigins: (TemplateOrigin | undefined)[] = [];
/** Set by a case that needs one template of a batch to fail. */
let failOnSlug: string | null = null;

/**
 * Stands in for the DOCX-and-S3 write: records the provenance it was asked to
 * store and inserts the row the rest of the flow reads back, so the handler's
 * duplicate detection runs against real rows and the real unique index.
 */
const createStoredTemplateMock = async function* ({
  organizationId,
  userId,
  name,
  fileName,
  origin,
}: CreateStoredTemplateOptions) {
  createdOrigins.push(origin);
  if (origin?.type === "bundled-pack" && origin.slug === failOnSlug) {
    return Result.err(
      new HandlerError({ status: 500, message: "storage write failed" }),
    );
  }
  const id = createSafeId<"template">();
  await testDb.insert(templates).values({
    id,
    organizationId,
    name,
    fileName,
    s3Key: `templates/${id}.docx`,
    sizeBytes: 1,
    createdBy: userId,
    originType: origin?.type ?? "authored",
    origin: origin ?? { type: "authored" },
  });
  return Result.ok({
    id,
    name,
    fileName,
    fieldCount: 0,
    sizeBytes: 1,
    createdAt: new Date(),
  });
};

const noopAudit = asTestRaw<AuditRecorder>(async () => undefined);

/** Two-template pack over the committed fixture content. */
const testCatalogue = () => {
  const fixture = createFixtureTemplatePackCatalogue().list().at(0);
  if (!fixture) {
    throw new Error("fixture catalogue must expose the sample pack");
  }
  const template = fixture.templates.at(0);
  if (!template) {
    throw new Error("fixture pack must expose a template");
  }
  const pack: GeneratedTemplatePack = {
    ...fixture,
    templates: [template, { ...template, slug: NEW_SLUG }],
  };
  return createFixtureTemplatePackCatalogue([pack]);
};

const fixtureHash = (): string => {
  const template = testCatalogue().list().at(0)?.templates.at(0);
  if (!template) {
    throw new Error("fixture pack must expose a template");
  }
  return template.sha256;
};

type BundledPackOrigin = Extract<TemplateOrigin, { type: "bundled-pack" }>;

/** Every member the pack branch declares; the constraint must require them all. */
const REQUIRED_PACK_ORIGIN_FIELDS = [
  "type",
  "packId",
  "packVersion",
  "slug",
  "contentHash",
  "license",
  "authors",
] as const satisfies readonly (keyof BundledPackOrigin)[];

const packOrigin = (slug: string, contentHash: string): BundledPackOrigin => {
  const pack = testCatalogue().list().at(0);
  const template = pack?.templates.at(0);
  if (!pack || !template) {
    throw new Error("fixture pack must expose a template");
  }
  return {
    type: "bundled-pack",
    packId: pack.id,
    packVersion: pack.version,
    slug,
    contentHash,
    license: template.license,
    authors: [...pack.authors],
  };
};

const install = async (
  templateSlugs: string[],
  role = "admin",
  catalogue = testCatalogue(),
) =>
  await Result.gen(() =>
    installTemplatePackHandler({
      catalogue,
      safeDb,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      memberRole: asTestRaw<{ role: "admin" }>({ role }),
      packId: PACK_ID,
      body: { templateSlugs },
      recordAuditEvent: noopAudit,
    }),
  );

/** The driver wraps the Postgres error, so the constraint name is in a cause. */
const messageChain = (error: unknown): string =>
  error instanceof Error
    ? `${error.message} ${messageChain(error.cause)}`
    : JSON.stringify(error ?? "");

/** The rejection a write is expected to produce, or a failure if it lands. */
const captureRejection = async (
  write: () => Promise<void>,
): Promise<string> => {
  try {
    await write();
  } catch (error: unknown) {
    return messageChain(error);
  }
  throw new Error("the write was expected to be refused");
};

const packTemplateRows = async () =>
  await testDb
    .select({
      id: templates.id,
      originType: templates.originType,
      origin: templates.origin,
    })
    .from(templates)
    .where(eq(templates.organizationId, ids.orgA));

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  safeDb = asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, ids.userAdmin));
  otherOrgSafeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, [], ids.orgB, ids.userB1),
  );
  const { installTemplatePackHandler: installTemplatePackHandlerImpl } =
    await import("./create");
  installTemplatePackHandler = (props) =>
    installTemplatePackHandlerImpl({
      ...props,
      createStoredTemplate: createStoredTemplateMock,
    });
});

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  createdOrigins.length = 0;
  failOnSlug = null;
  await testDb.delete(templates).where(eq(templates.organizationId, ids.orgA));
  await testDb.delete(templates).where(eq(templates.organizationId, ids.orgB));
});

/** One case per member: writing a pack origin without it must be refused. */
const declareOmissionCase = (
  omitted: (typeof REQUIRED_PACK_ORIGIN_FIELDS)[number],
): void => {
  test(`a pack origin without ${omitted} is refused`, async () => {
    const id = createSafeId<"template">();
    const complete: Record<string, unknown> = packOrigin(
      NEW_SLUG,
      fixtureHash(),
    );
    const payload = JSON.stringify(
      Object.fromEntries(
        Object.entries(complete).filter(([field]) => field !== omitted),
      ),
    );

    const insertIncomplete = async () => {
      await testDb.execute(sql`
        INSERT INTO templates
          (id, organization_id, name, file_name, s3_key, size_bytes, created_by, origin_type, origin)
        VALUES
          (${id}, ${ids.orgA}, 'Incomplete', 'x.docx', ${`templates/${id}.docx`},
           1, ${ids.userAdmin}, 'bundled-pack', ${payload}::text::jsonb)
      `);
    };

    const rejection = await captureRejection(insertIncomplete);

    expect(rejection).toContain(
      'violates check constraint "templates_origin_shape_check"',
    );
  });
};

describe("template pack install", () => {
  test("records the pack, version, slug and content hash it copied from", async () => {
    const result = await install([NEW_SLUG]);

    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.items.map((item) => item.status)).toEqual([
      "installed",
    ]);
    expect(createdOrigins).toEqual([packOrigin(NEW_SLUG, fixtureHash())]);
    const rows = await packTemplateRows();
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.originType).toBe("bundled-pack");
    expect(rows.at(0)?.origin).toEqual(packOrigin(NEW_SLUG, fixtureHash()));
  });

  test("installing twice reports the first copy instead of making a second", async () => {
    const first = await install([INSTALLED_SLUG]);
    if (Result.isError(first)) {
      throw first.error;
    }
    const firstItem = first.value.items.at(0);
    if (!firstItem) {
      throw new Error("the first install must report a template");
    }

    const second = await install([INSTALLED_SLUG]);

    if (Result.isError(second)) {
      throw second.error;
    }
    expect(second.value.items).toEqual([
      {
        slug: INSTALLED_SLUG,
        status: "already-installed",
        templateId: firstItem.templateId,
      },
    ]);
    expect(createdOrigins).toHaveLength(1);
    expect(await packTemplateRows()).toHaveLength(1);
  });

  test("one request installs the missing template and reports the present one", async () => {
    await install([INSTALLED_SLUG]);

    const result = await install([INSTALLED_SLUG, NEW_SLUG]);

    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.items.map((item) => [item.slug, item.status])).toEqual([
      [INSTALLED_SLUG, "already-installed"],
      [NEW_SLUG, "installed"],
    ]);
    expect(await packTemplateRows()).toHaveLength(2);
  });

  // Deliberate design: each template is its own complete, idempotent commit
  // rather than one transaction for the batch. What that has to buy is that a
  // failure leaves no half-written template and the same request finishes the
  // job on a retry.
  test("a failed template leaves the earlier ones installed and the request repeatable", async () => {
    failOnSlug = NEW_SLUG;

    const failed = await install([INSTALLED_SLUG, NEW_SLUG]);

    expect(Result.isError(failed)).toBe(true);
    expect(await packTemplateRows()).toHaveLength(1);

    failOnSlug = null;
    const retry = await install([INSTALLED_SLUG, NEW_SLUG]);

    if (Result.isError(retry)) {
      throw retry.error;
    }
    expect(retry.value.items.map((item) => [item.slug, item.status])).toEqual([
      [INSTALLED_SLUG, "already-installed"],
      [NEW_SLUG, "installed"],
    ]);
    expect(await packTemplateRows()).toHaveLength(2);
  });

  test("the database refuses a second copy of the same pack template", async () => {
    await install([INSTALLED_SLUG]);

    // The handler's pre-read and this index guard the same invariant; only
    // the index survives two concurrent installs.
    const duplicate = createSafeId<"template">();
    const insertDuplicate = async () => {
      await testDb.insert(templates).values({
        id: duplicate,
        organizationId: ids.orgA,
        name: "Duplicate",
        fileName: "duplicate.docx",
        s3Key: `templates/${duplicate}.docx`,
        sizeBytes: 1,
        createdBy: ids.userAdmin,
        originType: "bundled-pack",
        origin: packOrigin(INSTALLED_SLUG, fixtureHash()),
      });
    };

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection = await captureRejection(insertDuplicate);

    expect(rejection).toContain(
      'duplicate key value violates unique constraint "templates_org_pack_template_uidx"',
    );
  });

  test("the origin column and its payload cannot disagree", async () => {
    const id = createSafeId<"template">();
    const payload = JSON.stringify(packOrigin(NEW_SLUG, fixtureHash()));

    const insertMismatch = async () => {
      await testDb.execute(sql`
        INSERT INTO templates
          (id, organization_id, name, file_name, s3_key, size_bytes, created_by, origin_type, origin)
        VALUES
          (${id}, ${ids.orgA}, 'Mismatched', 'x.docx', ${`templates/${id}.docx`},
           1, ${ids.userAdmin}, 'authored', ${payload}::text::jsonb)
      `);
    };

    const rejection = await captureRejection(insertMismatch);

    expect(rejection).toContain(
      'violates check constraint "templates_origin_shape_check"',
    );
  });

  test("the same slug from another pack is a different template", async () => {
    await install([INSTALLED_SLUG]);

    // Without packId in the unique key this insert would be refused, and the
    // duplicate case above would pass for the wrong reason.
    const other = createSafeId<"template">();
    const insertOtherPack = async () => {
      await testDb.insert(templates).values({
        id: other,
        organizationId: ids.orgA,
        name: "Same slug, other pack",
        fileName: "other.docx",
        s3Key: `templates/${other}.docx`,
        sizeBytes: 1,
        createdBy: ids.userAdmin,
        originType: "bundled-pack",
        origin: {
          ...packOrigin(INSTALLED_SLUG, fixtureHash()),
          packId: "another-pack",
        },
      });
    };

    await insertOtherPack();

    expect(await packTemplateRows()).toHaveLength(2);
  });

  test("the omission cases below cover every field of a pack origin", () => {
    // Binds the list to the payload the handler actually writes, so a new
    // member of the union arrives with its own omission case or fails here.
    expect(new Set(Object.keys(packOrigin(NEW_SLUG, fixtureHash())))).toEqual(
      new Set(REQUIRED_PACK_ORIGIN_FIELDS),
    );
  });

  for (const omitted of REQUIRED_PACK_ORIGIN_FIELDS) {
    declareOmissionCase(omitted);
  }

  test("a slug outside the pack is refused before anything is copied", async () => {
    const result = await install(["not-in-this-pack"]);

    expect(Result.isError(result)).toBe(true);
    expect(createdOrigins).toHaveLength(0);
    expect(await packTemplateRows()).toHaveLength(0);
  });

  test("a deployment whose content is not present offers nothing to install", async () => {
    const empty = createTemplatePackCatalogue({
      packs: testCatalogue().list(),
      contentRoot: "/nonexistent/template-packs-content",
    });

    const result = await install([NEW_SLUG], "admin", empty);

    expect(Result.isError(result)).toBe(true);
    expect(await packTemplateRows()).toHaveLength(0);
  });

  // The domain's tenant boundary: "already installed" is read through the
  // organization-scoped database, so another organization's copy must be
  // invisible both as a status and as a template id.
  test("another organization's copy is neither seen nor reused", async () => {
    const foreign = await Result.gen(() =>
      installTemplatePackHandler({
        catalogue: testCatalogue(),
        safeDb: otherOrgSafeDb,
        organizationId: ids.orgB,
        userId: ids.userB1,
        memberRole: asTestRaw<{ role: "admin" }>({ role: "owner" }),
        packId: PACK_ID,
        body: { templateSlugs: [INSTALLED_SLUG] },
        recordAuditEvent: noopAudit,
      }),
    );
    if (Result.isError(foreign)) {
      throw foreign.error;
    }
    const foreignId = foreign.value.items.at(0)?.templateId;

    const result = await install([INSTALLED_SLUG]);

    if (Result.isError(result)) {
      throw result.error;
    }
    const item = result.value.items.at(0);
    expect(item?.status).toBe("installed");
    expect(item?.templateId).not.toBe(foreignId);
    // The foreign row is really there — an unscoped read sees both copies —
    // so the organization-scoped read excluding it is the isolation working,
    // not an empty fixture.
    const everyCopy = await testDb
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.originType, "bundled-pack"));
    expect(everyCopy).toHaveLength(2);
    expect(await packTemplateRows()).toHaveLength(1);
  });

  test("members below admin cannot install", async () => {
    const result = await install([NEW_SLUG], "member");

    expect(Result.isError(result)).toBe(true);
    expect(await packTemplateRows()).toHaveLength(0);
  });
});
