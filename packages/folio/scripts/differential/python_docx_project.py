"""Structural projection of a DOCX file as parsed by python-docx.

Emits JSON on stdout matching the shape produced by `projection.ts` so the
two can be diffed structurally. Counters walk the OOXML element tree
(`w:p`, `w:r`, `w:tbl`, `w:sdt`) rather than python-docx's high-level
API, because the high-level API drops paragraphs nested in tables and
content controls — and the point of the differential test is to compare
all paragraphs/runs/SDTs in the body subtree against folio's parse.

Usage:
    python3 python_docx_project.py path/to/file.docx
"""

from __future__ import annotations

import json
import sys
from typing import Any

try:
    import docx
    from docx.oxml.ns import qn
except ImportError:  # pragma: no cover — surfaces an install hint
    sys.stderr.write(
        "python-docx not installed. Install with: pip install python-docx\n"
    )
    sys.exit(2)


SCHEMA_VERSION = 1


# OOXML SDT-type element -> normalised SdtType matching folio's union in
# packages/docx-core/src/model/content.ts. SDTs without an explicit type
# child fall back to "richText" — that mirrors folio's `parseSdtProperties`
# default (a rich-text content control is the OOXML default when no type
# element is present, so a w:sdtPr containing only w:alias/w:tag is still
# a rich-text control).
SDT_TYPE_ELEMENTS = (
    ("w:richText", "richText"),
    ("w:text", "plainText"),
    ("w:date", "date"),
    ("w:dropDownList", "dropdown"),
    ("w:comboBox", "comboBox"),
    ("w:checkbox", "checkbox"),  # w14:checkbox in practice; see below
    ("w:picture", "picture"),
    ("w:docPartObj", "buildingBlockGallery"),
    ("w:docPartList", "buildingBlockGallery"),
    ("w:group", "group"),
)

# Pre-resolve the qualified-name lookup so detect_sdt_type does not pay the
# `qn()` cost on every traversal step (it is called once per `w:sdt` in the
# document).
SDT_TYPE_MAP = tuple((qn(tag), normalised) for tag, normalised in SDT_TYPE_ELEMENTS)

# python-docx exposes w14 namespace via the same qn helper if the element
# is declared. We probe both namespaces for the checkbox case which lives
# under w14 in real-world templates.
W14_CHECKBOX = "{http://schemas.microsoft.com/office/word/2010/wordml}checkbox"


LOCK_VALUES = {"sdtLocked", "contentLocked", "sdtContentLocked", "unlocked"}

# Tags that can appear directly inside an inline `w:sdtContent`. Defined at
# module scope so project_sdt does not rebuild the set per call.
INLINE_TAGS = frozenset(
    {
        qn("w:r"),
        qn("w:hyperlink"),
        qn("w:fldSimple"),
        qn("w:sdt"),
        "{http://schemas.openxmlformats.org/officeDocument/2006/math}oMath",
        "{http://schemas.openxmlformats.org/officeDocument/2006/math}oMathPara",
    }
)

# Parent tags that mark an SDT as inline-scoped. `w:sdtContent`, the enclosing
# `w:sdt`, and the tracked-change wrappers `w:ins`/`w:del`/`w:moveFrom`/
# `w:moveTo` are transparent for scope classification: when an inline SDT is
# nested inside another inline SDT or wrapped by a tracked change, its direct
# XML parent is one of these wrappers rather than `w:p`/`w:hyperlink`/
# `w:smartTag`. Folio parses tracked-change wrappers through
# `parseParagraphContents` and lifts non-run SDTs back into paragraph-level
# inline content, so we walk past these ancestors to find the enclosing
# paragraph/hyperlink/smartTag that decides scope. Missing this step would
# misclassify wrapped inline SDTs as `block` and produce false
# `scope`/`childCount` divergences on fixtures with inserted/deleted/moved
# content controls.
INLINE_PARENT_TAGS = frozenset({qn("w:p"), qn("w:hyperlink"), qn("w:smartTag")})
SDT_CONTENT_TAG = qn("w:sdtContent")
SDT_TAG = qn("w:sdt")
SCOPE_TRANSPARENT_TAGS = frozenset(
    {
        SDT_CONTENT_TAG,
        SDT_TAG,
        qn("w:ins"),
        qn("w:del"),
        qn("w:moveFrom"),
        qn("w:moveTo"),
    }
)


def detect_sdt_type(sdt_pr: Any) -> str:
    """Map a w:sdtPr element to a normalised SdtType.

    Mirrors folio's `parseSdtProperties`: a content control without an
    explicit type child is a rich-text control by default.
    """
    if sdt_pr is None:
        return "richText"
    for qn_tag, normalised in SDT_TYPE_MAP:
        if sdt_pr.find(qn_tag) is not None:
            return normalised
    if sdt_pr.find(W14_CHECKBOX) is not None:
        return "checkbox"
    return "richText"


def text_attr(elem: Any, tag: str, attr: str = "w:val") -> str | None:
    child = elem.find(qn(tag))
    if child is None:
        return None
    return child.get(qn(attr))


RUN_TAG = qn("w:r")
FLD_CHAR_TAG = qn("w:fldChar")
FLD_CHAR_TYPE_ATTR = qn("w:fldCharType")


def run_field_char_type(run_elem: Any) -> str | None:
    """Return the fldCharType of the first w:fldChar inside this w:r, or None."""
    fld_char = run_elem.find(FLD_CHAR_TAG)
    if fld_char is None:
        return None
    return fld_char.get(FLD_CHAR_TYPE_ATTR)


def count_inline_children(sdt_content: Any) -> int:
    """Count direct inline children, collapsing complex fields to one item.

    A complex field is a `begin` fldChar w:r through the matching `end`
    fldChar w:r (with separator and result runs in between). Folio models
    the whole span as a single `complexField` `ParagraphContent` item, so
    we match that by counting the entire span as 1. Nested complex fields
    are common (e.g. PAGEREF inside a TOC entry) and tracked with a depth
    counter.
    """
    count = 0
    field_depth = 0
    for child in sdt_content:
        if child.tag != RUN_TAG:
            if field_depth == 0 and child.tag in INLINE_TAGS:
                count += 1
            continue
        char_type = run_field_char_type(child)
        if char_type == "begin":
            if field_depth == 0:
                count += 1
            field_depth += 1
            continue
        if char_type == "end":
            if field_depth > 0:
                field_depth -= 1
            continue
        if field_depth == 0:
            count += 1
    return count


def project_sdt(sdt_elem: Any) -> dict[str, Any]:
    """Project one w:sdt element into the normalised shape.

    `scope` is inferred from the parent element: an `sdt` inside `w:body`,
    `w:tc`, or another `w:sdtContent` of block scope is block-scoped;
    inside `w:p` it is inline.
    """
    sdt_pr = sdt_elem.find(qn("w:sdtPr"))
    sdt_content = sdt_elem.find(SDT_CONTENT_TAG)

    # Walk up past any `w:sdtContent`, `w:sdt`, or tracked-change wrappers
    # (`w:ins`/`w:del`/`w:moveFrom`/`w:moveTo`) so a nested or
    # tracked-change-wrapped inline SDT is still classified by the
    # surrounding `w:p`/`w:hyperlink`/`w:smartTag`. Folio preserves these
    # SDTs as `InlineSdt`, so misclassifying them as block here would
    # produce a false `scope`/`childCount` divergence on every fixture
    # with nested controls or inserted/deleted/moved content controls.
    scope_parent = sdt_elem.getparent()
    while scope_parent is not None and scope_parent.tag in SCOPE_TRANSPARENT_TAGS:
        scope_parent = scope_parent.getparent()
    scope_parent_tag = scope_parent.tag if scope_parent is not None else ""
    scope = "inline" if scope_parent_tag in INLINE_PARENT_TAGS else "block"

    alias = text_attr(sdt_pr, "w:alias") if sdt_pr is not None else None
    tag_val = text_attr(sdt_pr, "w:tag") if sdt_pr is not None else None
    lock = text_attr(sdt_pr, "w:lock") if sdt_pr is not None else None
    if lock not in LOCK_VALUES:
        lock = None

    if sdt_content is None:
        child_count = 0
    elif scope == "block":
        # Direct paragraph/table children.
        child_count = sum(
            1
            for child in sdt_content
            if child.tag in (qn("w:p"), qn("w:tbl"), qn("w:sdt"))
        )
    else:
        # Direct inline children: runs, hyperlinks, fields, nested SDTs,
        # math. Match the union in InlineSdt.content in content.ts.
        #
        # Complex fields span multiple direct `w:r` children
        # (`fldChar begin` … `instrText` … `fldChar separate` … result …
        # `fldChar end`), but folio collapses them into a single
        # `complexField` `ParagraphContent` item — see `ComplexField` in
        # `docx-core/src/model/content.ts` and the inline-SDT parser test
        # at `paragraphParser.test.ts:337`. To keep `childCount` aligned
        # we collapse the same range here: every `w:r` from a `begin`
        # fldChar up to and including the matching `end` fldChar counts
        # as one logical item. Nested complex fields are tracked with a
        # depth counter so an inner `begin`/`end` pair doesn't close the
        # outer field early.
        child_count = count_inline_children(sdt_content)

    out: dict[str, Any] = {
        "scope": scope,
        "sdtType": detect_sdt_type(sdt_pr),
        "childCount": child_count,
    }
    if alias is not None:
        out["alias"] = alias
    if tag_val is not None:
        out["tag"] = tag_val
    if lock is not None:
        out["lock"] = lock
    return out


def project(path: str) -> dict[str, Any]:
    doc = docx.Document(path)
    body = doc.element.body

    # Top-level blocks: direct children of <w:body> that are
    # paragraph/table/sdt. `w:sectPr` at the end of the body is metadata,
    # not a block.
    top_level_tags = {qn("w:p"), qn("w:tbl"), qn("w:sdt")}
    top_level_blocks = sum(1 for child in body if child.tag in top_level_tags)

    # Exclude paragraphs/tables nested inside textbox drawing content
    # (`w:txbxContent`). folio models drawing-anchored text as run-level
    # shape content rather than block content, so counting textbox paras
    # here would always diverge for an uninteresting reason. The
    # divergence on textbox-heavy fixtures is a known structural shape
    # difference, not a parse bug; track it separately if textbox parity
    # becomes interesting.
    def in_textbox(elem: Any) -> bool:
        parent = elem.getparent()
        while parent is not None:
            if parent.tag == qn("w:txbxContent"):
                return True
            parent = parent.getparent()
        return False

    total_paragraphs = sum(
        1 for p in body.findall(".//" + qn("w:p")) if not in_textbox(p)
    )
    total_tables = sum(
        1 for t in body.findall(".//" + qn("w:tbl")) if not in_textbox(t)
    )

    sdts = [
        project_sdt(elem)
        for elem in body.findall(".//" + qn("w:sdt"))
        if not in_textbox(elem)
    ]

    counts: dict[str, int] = {}
    for s in sdts:
        counts[s["sdtType"]] = counts.get(s["sdtType"], 0) + 1
        counts[s["scope"]] = counts.get(s["scope"], 0) + 1

    return {
        "schemaVersion": SCHEMA_VERSION,
        "totalParagraphs": total_paragraphs,
        "totalTables": total_tables,
        "topLevelBlocks": top_level_blocks,
        "sdts": sdts,
        "sdtCountsByType": counts,
    }


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python_docx_project.py <docx-path>\n")
        return 2
    sys.stdout.write(json.dumps(project(sys.argv[1]), indent=2))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
