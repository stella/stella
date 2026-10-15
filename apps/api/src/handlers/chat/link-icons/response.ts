import type { LinkIcon } from "@/api/handlers/chat/link-icons/origin";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

export const linkIconResponse = (icon: LinkIcon | null) => {
  const headers = {
    [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
  };
  if (!icon) {
    return Response.json({ type: "no-icon" } as const, { headers });
  }
  return new Response(new Uint8Array(icon.bytes), {
    headers: { ...headers, "Content-Type": icon.mime },
  });
};
