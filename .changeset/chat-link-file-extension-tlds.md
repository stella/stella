---
"@stll/chat": patch
---

Bare file names whose extension is also a top-level domain (for example `memo.md`, `smlouva.pl`, `build.sh`) are no longer detected as links. Such a name becomes a link only when it carries a scheme, a `www.` prefix or a path.
