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

rule ooxml_remote_template
{
    meta:
        description = "Document references a remote template (potential macro injection)"
        verdict = "malicious"

    strings:
        $attached = "attachedTemplate" ascii nocase
        $http = /https?:\/\// ascii nocase

    condition:
        $attached and $http
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
