import { registerInspectorView } from "@/components/inspector/view-registry";

/**
 * Built-in workspace inspector view kinds. Registered at module load
 * so the cross-tab BroadcastChannel validator (`isInspectorTab`) and
 * any future registry-driven dispatch path recognise these kinds.
 *
 * Rendering for the built-in kinds is currently inlined in
 * `inspector-panel.tsx` (they are tightly coupled to local hooks and
 * refs — PDF recency cap, DOCX edit session, rename ribbon, etc.).
 * Registering them here keeps the kind catalogue centralized and
 * lets future iterations migrate the renderers without changing
 * call sites.
 *
 * The built-in tab types have their own typed openers
 * (`openFile`, `openChat`, …) and are not opened via `openView`,
 * so structural validation here can stay loose. The closed-union
 * structural checks for built-in kinds live in `isInspectorTab`
 * itself and run before any registry lookup.
 */

const acceptAnyPayload = (_value: unknown): _value is unknown => true;

const BUILT_IN_KINDS = [
  "pdf",
  "task",
  "chat",
  "matter",
  "external",
  "skill-resource",
] as const;

for (const kind of BUILT_IN_KINDS) {
  registerInspectorView({
    type: kind,
    // Built-in renderers are inlined in `inspector-panel.tsx`; the
    // registry entry exists so unknown-kind lookups for these
    // discriminators don't fall through to the "unknown view"
    // fallback.
    render: () => null,
    railIcon: () => null,
    navigationPolicy: "persist",
    validate: acceptAnyPayload,
  });
}
