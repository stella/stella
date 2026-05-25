import { env } from "@/env";
import type {
  AttachmentDownloadResult,
  MailSnapshot,
  WorkspaceSummary,
} from "@/types";

class StellaApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellaApiError";
  }
}

type PropertySummary = {
  content: {
    type: string;
  };
  id: string;
  name: string;
};

type JsonRequestOptions<T> = {
  body?: unknown;
  method: "GET" | "POST" | "PUT";
  parse: (payload: unknown) => T;
  path: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractErrorMessage = (payload: unknown): string => {
  if (!isRecord(payload)) {
    return "Stella request failed";
  }

  const value = payload["value"];
  if (isRecord(value)) {
    const message = value["message"];
    if (typeof message === "string") {
      return message;
    }
  }

  const error = payload["error"];
  if (isRecord(error)) {
    const message = error["message"];
    if (typeof message === "string") {
      return message;
    }
  }

  const message = payload["message"];
  return typeof message === "string" ? message : "Stella request failed";
};

const readPayload = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
};

const requestJson = async <T>({
  body,
  method,
  parse,
  path,
}: JsonRequestOptions<T>): Promise<T> => {
  const init: RequestInit = {
    credentials: "include",
    method,
    signal: AbortSignal.timeout(10_000),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }

  const response = await fetch(`${env.apiBaseUrl}${path}`, {
    ...init,
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new StellaApiError(extractErrorMessage(payload));
  }
  return parse(payload);
};

const requestFormData = async <T>({
  body,
  parse,
  path,
}: {
  body: FormData;
  parse: (payload: unknown) => T;
  path: string;
}): Promise<T> => {
  const response = await fetch(`${env.apiBaseUrl}${path}`, {
    body,
    credentials: "include",
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new StellaApiError(extractErrorMessage(payload));
  }
  return parse(payload);
};

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const parseWorkspaces = (payload: unknown): WorkspaceSummary[] => {
  if (!isRecord(payload) || !Array.isArray(payload["workspaces"])) {
    throw new StellaApiError("Stella returned an invalid workspace list");
  }

  const workspaces: WorkspaceSummary[] = [];
  for (const item of payload["workspaces"]) {
    if (!isRecord(item)) {
      continue;
    }
    const id = asString(item["id"]);
    const name = asString(item["name"]);
    if (!id || !name) {
      continue;
    }
    const client = item["client"];
    const clientName = isRecord(client)
      ? asString(client["displayName"])
      : null;
    workspaces.push({
      clientName,
      id,
      lastActivityAt: asString(item["lastActivityAt"]),
      name,
      reference: asString(item["reference"]),
    });
  }

  return workspaces;
};

const parseProperties = (payload: unknown): PropertySummary[] => {
  if (!Array.isArray(payload)) {
    throw new StellaApiError("Stella returned an invalid property list");
  }

  const properties: PropertySummary[] = [];
  for (const item of payload) {
    if (!isRecord(item) || !isRecord(item["content"])) {
      continue;
    }
    const id = asString(item["id"]);
    const name = asString(item["name"]);
    const type = asString(item["content"]["type"]);
    if (!id || !name || !type) {
      continue;
    }
    properties.push({
      content: { type },
      id,
      name,
    });
  }

  return properties;
};

const parseIdResponse =
  (key: "entityId" | "id") =>
  (payload: unknown): string => {
    if (!isRecord(payload)) {
      throw new StellaApiError("Stella returned an invalid response");
    }

    const id = asString(payload[key]);
    if (!id) {
      throw new StellaApiError("Stella returned a response without an id");
    }

    return id;
  };

const parseEmptyResponse = () => undefined;

const encodePathPart = (value: string) => encodeURIComponent(value);

export const readWorkspaces = async (): Promise<WorkspaceSummary[]> =>
  await requestJson({
    method: "GET",
    parse: parseWorkspaces,
    path: "/v1/workspaces",
  });

const readProperties = async (
  workspaceId: string,
): Promise<PropertySummary[]> =>
  await requestJson({
    method: "GET",
    parse: parseProperties,
    path: `/v1/properties/${encodePathPart(workspaceId)}`,
  });

const createProperty = async ({
  contentType,
  name,
  workspaceId,
}: {
  contentType: "file" | "text";
  name: string;
  workspaceId: string;
}): Promise<string> =>
  await requestJson({
    body: {
      contentType,
      name,
      toolType: "manual-input",
    },
    method: "PUT",
    parse: parseIdResponse("id"),
    path: `/v1/properties/${encodePathPart(workspaceId)}`,
  });

const ensureProperty = async ({
  contentType,
  name,
  properties,
  workspaceId,
}: {
  contentType: "file" | "text";
  name: string;
  properties: PropertySummary[];
  workspaceId: string;
}): Promise<string> => {
  const existing = properties.find(
    (property) =>
      property.name === name && property.content.type === contentType,
  );

  if (existing) {
    return existing.id;
  }

  const createdId = await createProperty({ contentType, name, workspaceId });
  properties.push({
    content: { type: contentType },
    id: createdId,
    name,
  });
  return createdId;
};

const upsertTextField = async ({
  entityId,
  propertyId,
  value,
  workspaceId,
}: {
  entityId: string;
  propertyId: string;
  value: string;
  workspaceId: string;
}): Promise<void> => {
  await requestJson({
    body: {
      content: {
        type: "text",
        value,
        version: 1,
      },
      entityId,
      propertyId,
    },
    method: "POST",
    parse: parseEmptyResponse,
    path: `/v1/fields/${encodePathPart(workspaceId)}`,
  });
};

const uploadAttachment = async ({
  file,
  propertyId,
  workspaceId,
}: {
  file: File;
  propertyId: string;
  workspaceId: string;
}): Promise<void> => {
  const formData = new FormData();
  formData.set("file", file);
  formData.set("name", file.name);
  formData.set("propertyId", propertyId);

  await requestFormData({
    body: formData,
    parse: parseEmptyResponse,
    path: `/v1/entities/${encodePathPart(workspaceId)}/upload`,
  });
};

const joinAddresses = (addresses: MailSnapshot["to"]) =>
  addresses
    .map((address) =>
      address.name ? `${address.name} <${address.email}>` : address.email,
    )
    .join(", ");

const truncateFieldValue = (value: string): string => {
  const limit = 20_000;
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n\n[Truncated by Stella Outlook add-in]`;
};

export type SaveEmailResult = {
  attachmentCount: number;
  entityId: string;
  skippedAttachments: string[];
};

export const saveEmailToMatter = async ({
  attachmentResults,
  snapshot,
  workspaceId,
}: {
  attachmentResults: AttachmentDownloadResult[];
  snapshot: MailSnapshot;
  workspaceId: string;
}): Promise<SaveEmailResult> => {
  const properties = await readProperties(workspaceId);
  const fieldEntries = [
    {
      name: "Outlook from",
      value: snapshot.from ? joinAddresses([snapshot.from]) : "",
    },
    { name: "Outlook to", value: joinAddresses(snapshot.to) },
    { name: "Outlook cc", value: joinAddresses(snapshot.cc) },
    { name: "Outlook sent at", value: snapshot.sentAt ?? "" },
    { name: "Outlook conversation id", value: snapshot.conversationId ?? "" },
    { name: "Outlook item id", value: snapshot.itemId ?? "" },
    {
      name: "Outlook internet message id",
      value: snapshot.internetMessageId ?? "",
    },
    { name: "Outlook body", value: truncateFieldValue(snapshot.bodyText) },
  ];

  const entityId = await requestJson({
    body: {
      kind: "message",
      name: snapshot.subject || "(No subject)",
    },
    method: "PUT",
    parse: parseIdResponse("entityId"),
    path: `/v1/entities/${encodePathPart(workspaceId)}`,
  });

  for (const entry of fieldEntries) {
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
    const filePropertyId = await ensureProperty({
      contentType: "file",
      name: "File",
      properties,
      workspaceId,
    });

    for (const result of downloaded) {
      await uploadAttachment({
        file: result.file,
        propertyId: filePropertyId,
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
