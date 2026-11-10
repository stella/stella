---
"@stll/ai-catalog": minor
---

Add a `browse` override group. It has no defaults of its own: `MODEL_OVERRIDE_GROUP_TASK` maps it to `short-text`, and `inheritedOverrideGroup` names the group it follows while unset (`fast`). `ModelOverrideGroup` gains a member, so code that matches it exhaustively has to handle it; `ModelTask` is unchanged.
