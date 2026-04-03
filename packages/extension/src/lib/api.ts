import type { ClipData, Matter } from "../types";
import { API_BASE } from "./config";
import { storage } from "./storage";

const API_V1 = `${API_BASE}/v1`;

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

const request = async <T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> => {
  try {
    const token = await storage.getBearerToken();
    const headers = new Headers(init?.headers);
    headers.set("Content-Type", "application/json");
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const res = await fetch(`${API_V1}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${String(res.status)}: ${body}`,
        status: res.status,
      };
    }

    // SAFETY: Response JSON shape matches T by API contract.
    // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, error: message };
  }
};

type WorkspacesResponse = {
  workspaces: {
    id: string;
    name: string;
    reference: string;
  }[];
};

type ClipResponse = { entityId: string };

export const stellaApi = {
  getMatters: async (): Promise<ApiResult<Matter[]>> => {
    const result = await request<WorkspacesResponse>("/workspaces");
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      data: result.data.workspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        reference: ws.reference,
      })),
    };
  },

  // eslint-disable-next-line typescript/promise-function-async
  createClip: (
    workspaceId: string,
    data: ClipData,
  ): Promise<ApiResult<ClipResponse>> =>
    request<ClipResponse>(`/entities/${workspaceId}/clip`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
};
