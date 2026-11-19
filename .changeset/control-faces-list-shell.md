---
"@stll/ui": minor
---

`@stll/ui/control-face` draws the faces of controls for a loading view, from the classes the real controls are built from: `ButtonFace` (and `buttonFaceClassName` for a face a caller restyles), `InputFace`, `SplitButtonFace` and `FaceLabelPending`, a bar where a control's label waits on data. The button's size and variant classes move to `button-classes.ts`, which `Button` builds its variants from, and the split button's part classes are shared the same way. `@stll/ui/list-shell` holds the grouped list's group, header, title and surface with no popup, so a pending view can import it; `@stll/ui/list` re-exports them. It adds `ListItemSkeleton`, a row's placeholder at `ListItem` geometry, and `ListGroupTitlePending`. The composer tokens add `COMPOSER_STATUS_ROW_CENTERED_CLASS` and `COMPOSER_STATUS_ROW_CLASS`, which `ComposerStatusRow` renders from.
