import type { SafeId } from "@stll/api/types";
import { toSafeId } from "@stll/api/types";

import { api, withTimeout } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import type {
  AttachmentDownloadResult,
  MailSnapshot,
  WorkspaceSummary,
} from "@/types";

const OUTLOOK_NAMESPACE = "Outlook · ";

const PROPERTY_NAMES = {
  attachments: `${OUTLOOK_NAMESPACE}Attachments`,
  body: `${OUTLOOK_NAMESPACE}Body`,
  cc: `${OUTLOOK_NAMESPACE}CC`,
  conversationId: `${OUTLOOK_NAMESPACE}Conversation ID`,
  from: `${OUTLOOK_NAMESPACE}From`,
  internetMessageId: `${OUTLOOK_NAMESPACE}Internet message ID`,
  itemId: `${OUTLOOK_NAMESPACE}Outlook item ID`,
  sentAt: `${OUTLOOK_NAMESPACE}Sent at`,
  to: `${OUTLOOK_NAMESPACE}To`,
} as const;

const FIELD_BODY_MAX_LENGTH = 20_000;

const entitiesQueryKey = (workspaceId: string) => ["entities", workspaceId];
const propertiesQueryKey = (workspaceId: string) => ["properties", workspaceId];

type PropertyContentType = "file" | "text";

type PropertySummary = {
  id: SafeId<"property">;
  name: string;
  contentType: PropertyContentType;
};

const isManagedContentType = (
  type: string | null | undefined,
): type is PropertyContentType => type === "file" || type === "text";

export const readWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await api.workspaces.get(withTimeout());
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data.workspaces.map((workspace) => ({
    clientName: workspace.client?.displayName ?? null,
    id: workspace.id,
    lastActivityAt: workspace.lastActivityAt,
    name: workspace.name,
    reference: workspace.reference,
  }));
};

const readManagedProperties = async (
  workspaceId: SafeId<"workspace">,
): Promise<PropertySummary[]> => {
  const response = await api.properties({ workspaceId }).get(withTimeout());
  if (response.error) {
    throw toAPIError(response.error);
  }

  const properties: PropertySummary[] = [];
  for (const property of response.data) {
    if (!isManagedContentType(property.content.type)) {
      continue;
    }
    properties.push({
      contentType: property.content.type,
      id: property.id,
      name: property.name,
    });
  }
  return properties;
};

const createProperty = async ({
  contentType,
  name,
  workspaceId,
}: {
  contentType: PropertyContentType;
  name: string;
  workspaceId: SafeId<"workspace">;
}): Promise<SafeId<"property">> => {
  const response = await api.properties({ workspaceId }).put(
    {
      contentType,
      name,
      queryKey: propertiesQueryKey(workspaceId),
      toolType: "manual-input",
    },
    withTimeout(),
  );
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data.id;
};

const ensureProperty = async ({
  contentType,
  name,
  properties,
  workspaceId,
}: {
  contentType: PropertyContentType;
  name: string;
  properties: PropertySummary[];
  workspaceId: SafeId<"workspace">;
}): Promise<SafeId<"property">> => {
  const existing = properties.find(
    (property) =>
      property.name === name && property.contentType === contentType,
  );
  if (existing) {
    return existing.id;
  }

  const createdId = await createProperty({ contentType, name, workspaceId });
  properties.push({ contentType, id: createdId, name });
  return createdId;
};

const upsertTextField = async ({
  entityId,
  propertyId,
  value,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  value: string;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  const response = await api.fields({ workspaceId }).post(
    {
      content: { type: "text", value, version: 1 },
      entityId,
      propertyId,
      queryKey: entitiesQueryKey(workspaceId),
    },
    withTimeout(),
  );
  if (response.error) {
    throw toAPIError(response.error);
  }
};

const uploadAttachment = async ({
  file,
  propertyId,
  workspaceId,
}: {
  file: File;
  propertyId: SafeId<"property">;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  const response = await api.entities({ workspaceId }).upload.post(
    {
      file,
      name: file.name,
      propertyId,
      queryKey: entitiesQueryKey(workspaceId),
    },
    withTimeout(),
  );
  if (response.error) {
    throw toAPIError(response.error);
  }
};

const createMessageEntity = async ({
  name,
  workspaceId,
}: {
  name: string;
  workspaceId: SafeId<"workspace">;
}): Promise<SafeId<"entity">> => {
  const response = await api.entities({ workspaceId }).put(
    {
      kind: "message",
      name,
      queryKey: entitiesQueryKey(workspaceId),
    },
    withTimeout(),
  );
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data.entityId;
};

const joinAddresses = (addresses: MailSnapshot["to"]) =>
  addresses
    .map((address) =>
      address.name ? `${address.name} <${address.email}>` : address.email,
    )
    .join(", ");

const truncateFieldValue = (value: string): string => {
  if (value.length <= FIELD_BODY_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, FIELD_BODY_MAX_LENGTH)}\n\n[Truncated by Stella Outlook add-in]`;
};

const buildFieldEntries = (snapshot: MailSnapshot) => [
  {
    name: PROPERTY_NAMES.from,
    value: snapshot.from ? joinAddresses([snapshot.from]) : "",
  },
  { name: PROPERTY_NAMES.to, value: joinAddresses(snapshot.to) },
  { name: PROPERTY_NAMES.cc, value: joinAddresses(snapshot.cc) },
  { name: PROPERTY_NAMES.sentAt, value: snapshot.sentAt ?? "" },
  {
    name: PROPERTY_NAMES.conversationId,
    value: snapshot.conversationId ?? "",
  },
  { name: PROPERTY_NAMES.itemId, value: snapshot.itemId ?? "" },
  {
    name: PROPERTY_NAMES.internetMessageId,
    value: snapshot.internetMessageId ?? "",
  },
  { name: PROPERTY_NAMES.body, value: truncateFieldValue(snapshot.bodyText) },
];

export type SaveEmailResult = {
  attachmentCount: number;
  entityId: SafeId<"entity">;
  skippedAttachments: string[];
};

export const saveEmailToMatter = async ({
  attachmentResults,
  snapshot,
  workspaceId: workspaceIdString,
}: {
  attachmentResults: AttachmentDownloadResult[];
  snapshot: MailSnapshot;
  workspaceId: string;
}): Promise<SaveEmailResult> => {
  const workspaceId = toSafeId<"workspace">(workspaceIdString);
  const properties = await readManagedProperties(workspaceId);

  const entityId = await createMessageEntity({
    name: snapshot.subject || "(No subject)",
    workspaceId,
  });

  for (const entry of buildFieldEntries(snapshot)) {
    if (entry.value.length === 0) {
      continue;
    }
    const propertyId = await ensureProperty({
      contentType: "text",
      name: entry.name,
      properties,
      workspaceId,
    });
    await upsertTextField({
      entityId,
      propertyId,
      value: entry.value,
      workspaceId,
    });
  }

  const downloaded = attachmentResults.filter(
    (
      result,
    ): result is Extract<AttachmentDownloadResult, { type: "downloaded" }> =>
      result.type === "downloaded",
  );
  if (downloaded.length > 0) {
    const attachmentPropertyId = await ensureProperty({
      contentType: "file",
      name: PROPERTY_NAMES.attachments,
      properties,
      workspaceId,
    });
    for (const result of downloaded) {
      await uploadAttachment({
        file: result.file,
        propertyId: attachmentPropertyId,
        workspaceId,
      });
    }
  }

  return {
    attachmentCount: downloaded.length,
    entityId,
    skippedAttachments: attachmentResults
      .filter((result) => result.type === "skipped")
      .map((result) => result.reason),
  };
};

export { APIError };
