---
"@stll/cli": minor
---

The capability catalog lists `skills.export`, which downloads a skill as an Agent Skills archive (a ZIP with one folder named after the skill, holding `SKILL.md` and every resource file). It returns file bytes, so the generic `stella capability` transport does not run it; `skills get` covers the skill as JSON.
