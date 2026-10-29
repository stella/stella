import { createSafeId } from "@/api/lib/branded-types";
import { assertModelSurfaceFreeOfTenantIds } from "@/api/lib/chat/model-ingress-guard";

// A non-empty tenant set constructs and queries the real native matcher.
// Run as bundled JS so the compiled smoke cannot hide a missing sidecar.
assertModelSurfaceFreeOfTenantIds({
  serialized: "image smoke model prompt",
  surface: "system-prompt",
  workspaceIds: [createSafeId<"workspace">()],
});

console.log("image-smoke ok: model ingress guard");
