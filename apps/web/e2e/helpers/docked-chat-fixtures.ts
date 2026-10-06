import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import type { FileTab } from "../../src/components/inspector/file-tab";
import { apiDelete, apiPut, apiUploadTemplate, E2E_API_ORIGIN } from "./api";
import {
  dockedChatFileThreadPage,
  dockedChatMessagePage,
  dockedChatSuggestedPrompts,
  dockedChatTemplateThread,
  dockedChatTitle,
} from "./docked-chat-history";
import { createUploadedDocumentRoute } from "./document";
import { expect } from "./test";
import { createTestWorkspace, deleteTestWorkspace } from "./workspace";

const sessionSchema = v.object({
  user: v.object({ id: v.string() }),
  session: v.object({ activeOrganizationId: v.string() }),
});

export const createDockedChatWorld = async (request: APIRequestContext) => {
  const workspace = await createTestWorkspace(request, "dock-geometry");
  const contactId = randomUUID();
  let templateId: string | undefined;
  try {
    await apiPut(request, "/contacts", {
      id: contactId,
      type: "person",
      displayName: "Dock geometry fixture",
    });
    const document = await createUploadedDocumentRoute({
      request,
      workspace,
      fileName: "dock-geometry.docx",
    });
    const fieldId = new URL(
      document.path,
      "https://fixture.test",
    ).searchParams.get("field");
    if (fieldId === null) {
      throw new Error("Uploaded document has no file field");
    }
    const template = await apiUploadTemplate(request, {
      file: {
        name: "dock-geometry.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: await readFile(
          path.resolve(import.meta.dirname, "../fixtures/simple.docx"),
        ),
      },
      name: "Dock geometry fixture",
    });
    templateId = template.id;
    const response = await request.get(
      `${E2E_API_ORIGIN}/api/auth/get-session`,
    );
    expect(response.ok()).toBe(true);
    const session = v.parse(sessionSchema, await response.json());
    const fileTab = {
      type: "pdf",
      id: fieldId,
      entityId: document.entityId,
      label: "dock-geometry.docx",
      fileName: "dock-geometry.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdfFileId: fieldId,
      workspaceId: workspace.id,
      propertyId: workspace.filePropertyId,
    } satisfies FileTab;
    return {
      workspace,
      document,
      contactId,
      templateId: template.id,
      session,
      fileTab,
    };
  } catch (error) {
    if (templateId !== undefined) {
      await apiDelete(request, `/templates/${templateId}`);
    }
    await apiDelete(request, `/contacts/${contactId}`);
    await deleteTestWorkspace(request, workspace.id);
    throw error;
  }
};
export type DockedChatWorld = Awaited<ReturnType<typeof createDockedChatWorld>>;

export const deleteDockedChatWorld = async (
  request: APIRequestContext,
  world: DockedChatWorld,
) => {
  await apiDelete(request, `/templates/${world.templateId}`);
  await apiDelete(request, `/contacts/${world.contactId}`);
  await deleteTestWorkspace(request, world.workspace.id);
};

/** HTTP fixtures isolate geometry from model availability; the real readers,
 * runtime, hydration and portals still mount against the seeded signed-in stack. */
export const installDockedChatHistory = async (page: Page) => {
  await page.route(
    /\/v1\/chat\/workspaces\/[^/]+\/file-thread(?:\?|$)/u,
    async (route) => {
      await route.fulfill({ json: dockedChatFileThreadPage });
    },
  );
  await page.route("**/v1/chat/template-thread", async (route) => {
    await route.fulfill({ json: dockedChatTemplateThread });
  });
  await page.route("**/v1/chat/threads/*/messages*", async (route) => {
    await route.fulfill({ json: dockedChatMessagePage });
  });
  await page.route("**/v1/chat/threads/*/suggested-prompts*", async (route) => {
    await route.fulfill({ json: dockedChatSuggestedPrompts });
  });
  await page.route("**/v1/chat/threads/*/title*", async (route) => {
    await route.fulfill({ json: dockedChatTitle });
  });
};

type RestoreGeometryInspectorOptions = {
  world: DockedChatWorld;
  presentation: "inspector" | "reader";
};
export const restoreGeometryInspector = async (
  page: Page,
  { world, presentation }: RestoreGeometryInspectorOptions,
) => {
  await page.addInitScript(
    ({ userId, organizationId, fileTab, mode }) => {
      const suffix = `${organizationId}:${userId}`;
      localStorage.setItem(
        `stella:inspector-state:v1:${suffix}`,
        JSON.stringify({
          tabs: mode === "inspector" ? [fileTab] : [],
          groups: [],
          groupAssignments: {},
          activeId: mode === "inspector" ? fileTab.id : null,
          collapsedGroupIds: [],
        }),
      );
      localStorage.setItem(
        `stella:inspector-minimized:v1:${suffix}`,
        mode === "inspector" ? "0" : "1",
      );
    },
    {
      userId: world.session.user.id,
      organizationId: world.session.session.activeOrganizationId,
      fileTab: world.fileTab,
      mode: presentation,
    },
  );
};
