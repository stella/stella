rule svg_script_tag
{
    meta:
        description = "SVG contains script tag (potential XSS)"
        verdict = "suspicious"

    strings:
        $svg = "<svg" ascii nocase
        $script = "<script" ascii nocase

    condition:
        $svg and $script
}

rule svg_event_handler
{
    meta:
        description = "SVG contains event handler attributes (potential XSS)"
        verdict = "suspicious"

    strings:
        $svg = "<svg" ascii nocase
        $onload = /on(load|error|click|mouseover|focus)\s*=/ ascii nocase

    condition:
        $svg and $onload
}

rule svg_foreign_object
{
    meta:
        description = "SVG contains foreignObject (can embed arbitrary HTML)"
        verdict = "suspicious"

    strings:
        $svg = "<svg" ascii nocase
        $foreign = "<foreignObject" ascii nocase

    condition:
        $svg and $foreign
}

rule svg_javascript_uri
{
    meta:
        description = "SVG contains javascript: URI (potential XSS)"
        verdict = "suspicious"

    strings:
        $svg = "<svg" ascii nocase
        $js = "javascript:" ascii nocase

    condition:
        $svg and $js
}

rule svg_external_reference
{
    meta:
        description = "SVG contains external xlink:href reference"
        verdict = "suspicious"

    strings:
        $svg = "<svg" ascii nocase
        $xlink1 = /xlink:href\s*=\s*["']https?:/ ascii nocase
        $xlink2 = /href\s*=\s*["']data:/ ascii nocase

    condition:
        $svg and ($xlink1 or $xlink2)
}
