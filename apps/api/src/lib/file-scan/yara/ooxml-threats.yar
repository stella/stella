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
        $target_mode = "TargetMode" ascii nocase
        $external = "External" ascii nocase
        $http = /https?:\/\// ascii nocase

    condition:
        $target_mode and $external and $http
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
