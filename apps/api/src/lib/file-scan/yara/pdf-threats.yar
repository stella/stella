rule pdf_javascript_js
{
    meta:
        description = "PDF contains /JS action (embedded JavaScript)"
        verdict = "malicious"

    strings:
        $header = "%PDF-" ascii
        $js = "/JS" ascii

    condition:
        $header and $js
}

rule pdf_javascript_full
{
    meta:
        description = "PDF contains /JavaScript action (embedded JavaScript)"
        verdict = "malicious"

    strings:
        $header = "%PDF-" ascii
        $js = "/JavaScript" ascii

    condition:
        $header and $js
}

rule pdf_launch
{
    meta:
        description = "PDF contains /Launch action (can execute programs)"
        verdict = "malicious"

    strings:
        $header = "%PDF-" ascii
        $launch = "/Launch" ascii

    condition:
        $header and $launch
}

rule pdf_embedded_file
{
    meta:
        description = "PDF contains embedded file attachments"
        verdict = "suspicious"

    strings:
        $header = "%PDF-" ascii
        $embed = "/EmbeddedFile" ascii

    condition:
        $header and $embed
}

rule pdf_open_action_uri
{
    meta:
        description = "PDF contains auto-redirect (OpenAction with URI)"
        verdict = "suspicious"

    strings:
        $header = "%PDF-" ascii
        $open = "/OpenAction" ascii
        $uri = "/URI" ascii

    condition:
        $header and $open and $uri
}
