rule pdf_javascript_js
{
    meta:
        description = "PDF contains /JS action (embedded JavaScript)"
        verdict = "malicious"

    strings:
        $header = "%PDF-" ascii
        // Match /JS followed by a PDF delimiter to avoid
        // false positives on font subset names (/JSUIQA+Arial)
        $js = /\/JS[\s\x00(<]/ ascii

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
        $launch = /\/Launch[\s\x00\/<(]/ ascii

    condition:
        $header and $launch
}

rule pdf_submit_form
{
    meta:
        description = "PDF contains /SubmitForm action (can exfiltrate form data)"
        verdict = "suspicious"

    strings:
        $header = "%PDF-" ascii
        $submit = /\/SubmitForm[\s\x00\/<(]/ ascii

    condition:
        $header and $submit
}

rule pdf_goto_remote
{
    meta:
        description = "PDF contains /GoToR action (opens remote file)"
        verdict = "suspicious"

    strings:
        $header = "%PDF-" ascii
        $goto = /\/GoToR[\s\x00\/<(]/ ascii

    condition:
        $header and $goto
}

rule pdf_goto_embedded
{
    meta:
        description = "PDF contains /GoToE action (opens embedded file)"
        verdict = "suspicious"

    strings:
        $header = "%PDF-" ascii
        $goto = /\/GoToE[\s\x00\/<(]/ ascii

    condition:
        $header and $goto
}

rule pdf_rich_media
{
    meta:
        description = "PDF contains /RichMedia (embedded Flash/multimedia)"
        verdict = "suspicious"

    strings:
        $header = "%PDF-" ascii
        $rich = /\/RichMedia[\s\x00\/<(]/ ascii

    condition:
        $header and $rich
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
