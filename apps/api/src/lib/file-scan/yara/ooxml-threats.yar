rule ooxml_xxe_entity
{
    meta:
        description = "Document contains XML external entity declaration (XXE)"
        verdict = "malicious"

    strings:
        $entity = "<!ENTITY" ascii nocase
        $system = "SYSTEM" ascii nocase
        $public = "PUBLIC" ascii nocase

    condition:
        $entity and ($system or $public)
}

rule ooxml_external_relationship
{
    meta:
        description = "Document contains external relationship target"
        verdict = "suspicious"

    strings:
        // One <Relationship> element resolving outside the package.
        // [^>] keeps each match inside a single element, and either XML
        // quote form delimits the attribute value.
        $external = /<Relationship[^>]{0,1035}TargetMode[\s]{0,8}=[\s]{0,8}("External"|'External')/ ascii nocase
        // The same element when it carries the hyperlink relationship
        // type, which every document body link produces. The two spans plus
        // the type token total the single span above (512 + 11 + 512), so an
        // element matching here always matches $external at the same offset.
        $hyperlink = /<Relationship[^>]{0,512}\/hyperlink("|')[^>]{0,512}TargetMode[\s]{0,8}=[\s]{0,8}("External"|'External')/ ascii nocase

    condition:
        // Fires only when an external relationship is something other than
        // a hyperlink. Both strings start at the same `<Relationship`, so
        // the counts differ exactly by the non-hyperlink elements.
        #external > #hyperlink
}

rule ooxml_activex
{
    meta:
        description = "Document contains ActiveX controls"
        verdict = "malicious"

    strings:
        $content_types = "[Content_Types].xml" ascii
        $activex = "activeX" ascii nocase

    condition:
        $content_types and $activex
}

rule html_external_reference
{
    meta:
        description = "HTML contains an external resource reference"
        verdict = "suspicious"
    strings:
        $doctype = /<!doctype[\s]+html(?:[\s>])/ ascii nocase
        $html = /<html(?:[\s>])/ ascii nocase
        $head = /<head(?:[\s>])/ ascii nocase
        $body = /<body(?:[\s>])/ ascii nocase
        $attribute = /<(?:img|image|script|iframe|frame|video|audio|source|object|embed|input|body|table|td)[^>]{0,1024}(?:src|srcset|poster|data|background|href|xlink:href)[\s]{0,8}=[\s]{0,8}("|')(?:https?:|ftp:|file:|\/\/)/ ascii nocase
        $link = /<link[^>]{0,1024}href[\s]{0,8}=[\s]{0,8}("|')(?:https?:|ftp:|file:|\/\/)/ ascii nocase
        $base = /<base(?:[\s>])/ ascii nocase
        $refresh = /<meta[^>]{0,1024}http-equiv[\s]{0,8}=[\s]{0,8}("|')refresh("|')/ ascii nocase
        $css = /(?:@import|url\()[\s]{0,8}("|')?(?:https?:|ftp:|file:|\/\/)/ ascii nocase
    condition:
        any of ($doctype, $html, $head, $body) in (0..4096) and
        any of ($attribute, $link, $base, $refresh, $css)
}

rule odf_external_reference
{
    meta:
        description = "ODF contains an external resource reference"
        verdict = "suspicious"
    strings:
        $href = /<(?:draw:image|draw:object|draw:object-ole|draw:frame)[^>]{0,1024}xlink:href[\s]{0,8}=[\s]{0,8}("|')(?:https?:|ftp:|file:|\/\/)/ ascii nocase
    condition:
        $href
}

rule rtf_external_reference
{
    meta:
        description = "RTF contains an external resource field"
        verdict = "suspicious"
    strings:
        $header = "{\\rtf" ascii nocase
        $field = /\\fldinst[\s]{1,32}(?:INCLUDEPICTURE|INCLUDETEXT|IMPORT|LINK)(?:[\s\}])/ ascii nocase
        $object_link = "\\objlink" ascii nocase
    condition:
        $header and ($field or $object_link)
}

rule ooxml_dde
{
    meta:
        description = "Document contains DDE field code (can execute commands)"
        verdict = "malicious"

    strings:
        $dde = /DDE(AUTO)?[\s(]/ ascii nocase
        $instr = "instrText" ascii nocase

    condition:
        $dde and $instr
}

rule ooxml_ole_object
{
    meta:
        description = "Document contains embedded OLE object"
        verdict = "suspicious"

    strings:
        $content_types = "[Content_Types].xml" ascii
        $ole = "oleObject" ascii nocase

    condition:
        $content_types and $ole
}
