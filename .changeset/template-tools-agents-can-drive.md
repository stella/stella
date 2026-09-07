---
"@stll/cli": patch
---

`template save` is replaced by `template create` and `template configure-fields`, one command per intent. Creating a template returns the fields the document declares and the exact configure call to make next, and passing a template id publishes a new version of that template rather than a second one. A field's "who fills this" is now a single `source` with a type (`person`, `ai`, `lookup`, `contact`, `party`, `matter`, `attorney`, `firm`, `formula`, `condition`) instead of six keys that could contradict each other, and configuring fields applies the entries it can and reports the rest per entry instead of refusing the whole call.
