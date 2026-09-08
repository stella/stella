---
"@stll/template-conditions": minor
"@stll/cli": patch
---

The template marker grammar is the docxtpl dialect of Jinja: `{{ path | filter(…) }}` value markers whose filter chain carries the field configuration, `{% if %}` / `{% elif %}` / `{% else %}` / `{% endif %}`, `{% for alias in path %}` … `{% endfor %}` with `loop.*` counters, `{%p %}` and `{%tr %}` placement, and `clause()` / `num()` / `ref()` functions. The old `{{#each}}` / `{{#if}}` / `{{@…}}` forms are rejected as `legacy_marker` with the exact replacement named. The CLI catalog follows the tool schemas: composites (`parts`, `format`) leave the agent wire and a maximum constraint is at least 1.
