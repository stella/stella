import { panic, Result } from "better-result";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";
import { verifyAndDeleteUser } from "@/api/lib/delete-account";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { reviewOrganizationConfigFrom } from "@/api/lib/review-organization/config";
import { resetReviewOrganization } from "@/api/lib/review-organization/reset";
import type { ReviewResetDependencies } from "@/api/lib/review-organization/reset";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import { insertOwnerContacts } from "@/api/tests/helpers/owner-contacts";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";

// timeout: real email-code sign-ins, account deletion and the review reset
// run against migrated Postgres.
setDefaultTimeout(180_000);

/**
 * Who sees an organization's contacts once a principal leaves it: removed
 * from the organization, deleted with their account, or reset with the review
 * organization. Every read goes through the contacts route with the
 * principal's own session, and every row check through the owner scope of
 * the organization it names, so neither side can see another organization.
 */
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const server = serveRoutesForTest(contactsRoute);
const organizationIds = new Set<string>();
const userIds = new Set<string>();

afterAll(async () => {
  await server.stop();
  if (organizationIds.size > 0) {
    await rootDb
      .delete(organization)
      .where(inArray(organization.id, [...organizationIds]));
  }
  if (userIds.size > 0) {
    await rootDb.delete(user).where(inArray(user.id, [...userIds]));
  }
});

const signIn = async (label: string) => {
  const browser = await signInHuman(
    `${label}-${Bun.randomUUIDv7()}@kancelar.test`,
  );
  userIds.add(browser.userId);
  return browser;
};

const createOrganization = async (owner: HumanBrowser, name: string) => {
  const created = await getAuth().api.createOrganization({
    body: { name, slug: `contacts-visibility-${Bun.randomUUIDv7()}` },
    headers: owner.headers(),
  });
  organizationIds.add(created.id);
  await owner.setActiveOrganization(created.id);
  return brandPersistedOrganizationId(created.id);
};

const addMember = async ({
  owner,
  organizationId,
  member,
}: {
  owner: HumanBrowser;
  organizationId: SafeId<"organization">;
  member: HumanBrowser;
}) =>
  await getAuth().api.addMember({
    body: { organizationId, userId: member.userId, role: "member" },
    headers: owner.headers(),
  });

type ContactInput = {
  displayName: string;
  organizationName?: string;
  responsibleAttorneyId?: string;
};

const createContact = async (
  browser: HumanBrowser,
  input: ContactInput,
): Promise<SafeId<"contact">> => {
  const id = createSafeId<"contact">();
  const response = await server.fetch(
    new Request("http://localhost/contacts", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: browser.cookieHeader(),
      },
      body: JSON.stringify({
        id,
        type: "organization",
        organizationName: input.organizationName ?? input.displayName,
        ...input,
      }),
    }),
  );
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return id;
};

/** What the principal's session reads from the contacts list. */
const listContacts = async (browser: HumanBrowser) => {
  const response = await server.fetch(
    new Request("http://localhost/contacts?limit=100", {
      headers: { cookie: browser.cookieHeader() },
    }),
  );
  return { status: response.status, text: await response.text() };
};

const visibleIds = (text: string, ids: readonly string[]) =>
  ids.filter((id) => text.includes(id));

/** The organization's stored contacts, read inside its own owner scope. */
const storedContacts = async (organizationId: SafeId<"organization">) =>
  await withOwnerOrganizationScope(
    rootDb,
    organizationId,
    async (tx) =>
      await tx
        .select({
          id: contacts.id,
          organizationId: contacts.organizationId,
          responsibleAttorneyId: contacts.responsibleAttorneyId,
        })
        .from(contacts)
        .where(eq(contacts.organizationId, organizationId)),
  );

describe.skipIf(!runPostgresTests)(
  "contact visibility after a principal leaves an organization (postgres)",
  () => {
    test("a removed member reads none of the organization's contacts; the remaining members still do", async () => {
      const owner = await signIn("vlastnik");
      const leaver = await signIn("odchazejici");
      const otherOwner = await signIn("jina-kancelar");
      const firmId = await createOrganization(
        owner,
        "Advokátní kancelář Novák",
      );
      const otherFirmId = await createOrganization(
        otherOwner,
        "Kancelář Dvořák & partneři",
      );
      await addMember({ owner, organizationId: firmId, member: leaver });
      await leaver.setActiveOrganization(firmId);
      const firmContacts = [
        await createContact(owner, { displayName: "Stavby Kolín s.r.o." }),
        await createContact(owner, { displayName: "Jana Procházková" }),
      ];
      const otherContacts = [
        await createContact(otherOwner, { displayName: "Pekárna Brno a.s." }),
      ];
      const everyId = [...firmContacts, ...otherContacts];

      const before = await listContacts(leaver);
      expect(before.status, before.text).toBe(200);
      expect(visibleIds(before.text, everyId)).toEqual(firmContacts);

      const membership = await getAuth().api.listMembers({
        query: { organizationId: firmId },
        headers: owner.headers(),
      });
      const leaverMember =
        membership.members.find(({ userId }) => userId === leaver.userId) ??
        panic("The departing member's membership is missing");
      await getAuth().api.removeMember({
        body: { organizationId: firmId, memberIdOrEmail: leaverMember.id },
        headers: owner.headers(),
      });

      const after = await listContacts(leaver);
      expect(after.status).not.toBe(200);
      expect(visibleIds(after.text, everyId)).toEqual([]);
      // The other organization stays out of reach too.
      const switched = await getAuth().api.setActiveOrganization({
        body: { organizationId: otherFirmId },
        headers: leaver.headers(),
        asResponse: true,
      });
      expect(switched.ok).toBe(false);
      expect(visibleIds((await listContacts(leaver)).text, everyId)).toEqual(
        [],
      );

      const remaining = await listContacts(owner);
      expect(remaining.status, remaining.text).toBe(200);
      expect(visibleIds(remaining.text, everyId)).toEqual(firmContacts);
      const other = await listContacts(otherOwner);
      expect(visibleIds(other.text, everyId)).toEqual(otherContacts);
      expect(
        (await storedContacts(firmId)).map(({ id }) => id).toSorted(),
      ).toEqual(firmContacts.toSorted());
    });

    test("a deleted account reads nothing, and every organization it belonged to keeps its contacts without the account's attorney references", async () => {
      const firstOwner = await signIn("vlastnik-prvni");
      const secondOwner = await signIn("vlastnik-druhy");
      const thirdOwner = await signIn("vlastnik-treti");
      const departing = await signIn("rusi-ucet");
      const firstFirmId = await createOrganization(
        firstOwner,
        "Advokátní kancelář Svoboda",
      );
      const secondFirmId = await createOrganization(
        secondOwner,
        "Notářská kancelář Malá",
      );
      const thirdFirmId = await createOrganization(
        thirdOwner,
        "Kancelář Horák",
      );
      await addMember({
        owner: firstOwner,
        organizationId: firstFirmId,
        member: departing,
      });
      await addMember({
        owner: secondOwner,
        organizationId: secondFirmId,
        member: departing,
      });
      await departing.setActiveOrganization(firstFirmId);
      const firstContacts = [
        await createContact(firstOwner, {
          displayName: "Vinařství Mikulov s.r.o.",
          responsibleAttorneyId: departing.userId,
        }),
        await createContact(firstOwner, { displayName: "Petr Veselý" }),
      ];
      const secondContacts = [
        await createContact(secondOwner, {
          displayName: "Truhlářství Jihlava",
          responsibleAttorneyId: departing.userId,
        }),
      ];
      // The account never belonged to the third organization.
      const thirdContacts = [
        await createContact(thirdOwner, { displayName: "Autodoprava Zlín" }),
      ];
      const everyId = [...firstContacts, ...secondContacts, ...thirdContacts];

      const before = await listContacts(departing);
      expect(before.status, before.text).toBe(200);
      expect(visibleIds(before.text, everyId)).toEqual(firstContacts);

      const otp = await createConfirmationOtp({
        purpose: "delete-account",
        email: departing.email,
      });
      if (otp.isErr()) {
        throw otp.error;
      }
      const deletion = await verifyAndDeleteUser(
        brandPersistedUserId(departing.userId),
        departing.email,
        otp.value,
      );
      expect(Result.isOk(deletion)).toBe(true);
      // The anonymized account row stays behind its deletion request.
      userIds.delete(departing.userId);

      const after = await listContacts(departing);
      expect(after.status).not.toBe(200);
      expect(visibleIds(after.text, everyId)).toEqual([]);

      for (const [browser, own] of [
        [firstOwner, firstContacts],
        [secondOwner, secondContacts],
        [thirdOwner, thirdContacts],
      ] as const) {
        const read = await listContacts(browser);
        expect(read.status, read.text).toBe(200);
        expect(visibleIds(read.text, everyId)).toEqual([...own]);
      }
      // Each organization the account belonged to dropped its references in
      // its own scope; the contacts themselves stay.
      for (const [organizationId, own] of [
        [firstFirmId, firstContacts],
        [secondFirmId, secondContacts],
        [thirdFirmId, thirdContacts],
      ] as const) {
        const stored = await storedContacts(organizationId);
        expect(stored.map(({ id }) => id).toSorted()).toEqual(
          [...own].toSorted(),
        );
        expect(
          stored.every(
            ({ responsibleAttorneyId }) => responsibleAttorneyId === null,
          ),
        ).toBe(true);
      }
    });

    test("a reset review organization keeps none of the reviewer's contacts, and other organizations keep theirs", async () => {
      const reviewer = await signIn("recenzent");
      const foreignOwner = await signIn("cizi-kancelar");
      const reviewOrganizationId = await createOrganization(
        reviewer,
        "Recenzní kancelář",
      );
      const foreignOrganizationId = await createOrganization(
        foreignOwner,
        "Advokátní kancelář Černá",
      );
      const reviewContacts = [
        await createContact(reviewer, { displayName: "Sklárna Nový Bor" }),
        await createContact(reviewer, { displayName: "Lucie Kratochvílová" }),
      ];
      const foreignContacts = [
        await createContact(foreignOwner, {
          displayName: "Pivovar Ostrava a.s.",
        }),
      ];
      // Written after the reset read the organization's contacts, so only the
      // closing sweep can take it.
      const lateContactId = createSafeId<"contact">();
      const everyId = [...reviewContacts, ...foreignContacts, lateContactId];

      const before = await listContacts(reviewer);
      expect(visibleIds(before.text, everyId)).toEqual(reviewContacts);

      const fakeS3 = startFakeS3();
      const documentDependencies: CreateEntityFromBufferDependencies = {
        broadcastWorkspaceResourceUpdated: () => {},
        enqueueImageThumbnailOrMarkFailed: async () => {},
        enqueuePdfDerivativeOrMarkFailed: async () => {},
        processExtraction: async () => {},
        enqueueEntitySearchRepairs,
        flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
        requestNativeExtractionRun: async () => null,
      };
      const dependencies: ReviewResetDependencies = {
        flushWorkspaceSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
        seed: { documents: documentDependencies },
        workspaceDeletion: { enqueueCleanup: async () => {} },
        beforeSweep: async () => {
          await insertOwnerContacts(rootDb, [
            {
              id: lateContactId,
              organizationId: reviewOrganizationId,
              type: "person",
              displayName: "Opožděný kontakt",
            },
          ]);
        },
      };
      try {
        const outcome = await resetReviewOrganization({
          config:
            reviewOrganizationConfigFrom({
              APP_REVIEW_ACCOUNT_EMAIL: reviewer.email,
              APP_REVIEW_ORGANIZATION_ID: reviewOrganizationId,
            }) ?? panic("The review organization configuration is incomplete"),
          db: rootDb,
          runId: Bun.randomUUIDv7(),
          signal: new AbortController().signal,
          dependencies,
        });
        if (outcome.isErr()) {
          throw outcome.error;
        }
        expect(outcome.value.failures).toEqual([]);
        expect(outcome.value.swept.get("contacts")).toBe(1);
      } finally {
        fakeS3.stop();
      }

      const after = await listContacts(reviewer);
      expect(after.status, after.text).toBe(200);
      expect(visibleIds(after.text, everyId)).toEqual([]);
      const stored = (await storedContacts(reviewOrganizationId)).map(
        ({ id }) => id,
      );
      expect(visibleIds(stored.join(" "), everyId)).toEqual([]);
      // Every contact the review organization holds now is the fresh sample,
      // and the reviewer reads exactly those.
      expect(visibleIds(after.text, stored)).toEqual(stored);

      const foreign = await listContacts(foreignOwner);
      expect(foreign.status, foreign.text).toBe(200);
      expect(visibleIds(foreign.text, everyId)).toEqual(foreignContacts);
      expect(visibleIds(foreign.text, stored)).toEqual([]);
      expect(
        (await storedContacts(foreignOrganizationId)).map(({ id }) => id),
      ).toEqual(foreignContacts);
    });
  },
);
