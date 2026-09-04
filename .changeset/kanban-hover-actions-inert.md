---
"@stll/ui": patch
---

A kanban card's hover-revealed actions no longer sit in the way while they are
hidden. They took pointer events at rest and stayed visible on pointers that
cannot hover, which left a small dead zone in the corner of every card: on a
touch device a press there reached the actions instead of the card, so it never
started the card's drag. Each pointer now has its own way to them — hover, tab,
or, for a finger, opening the card, whose actions stay out while it is active.
