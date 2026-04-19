rule ooxml_macros
{
    meta:
        description = "Document contains VBA macro project (vbaProject.bin)"
        verdict = "suspicious"

    strings:
        $content_types = "[Content_Types].xml" ascii
        $vba = "vbaProject.bin" ascii

    condition:
        $content_types and $vba
}

rule ole2_container
{
    meta:
        description = "File is a legacy OLE2 compound document"
        verdict = "suspicious"

    strings:
        $magic = { D0 CF 11 E0 A1 B1 1A E1 }

    condition:
        $magic at 0
}

rule office_macro_suspicious_words
{
    meta:
        description = "Office macro contains suspicious VBA keywords"
        verdict = "malicious"

    strings:
        $a1 = "AutoOpen" ascii nocase
        $a2 = "Document_Open" ascii nocase
        $a3 = "Workbook_Open" ascii nocase
        $b1 = "CreateObject" ascii nocase
        $b2 = "WScript.Shell" ascii nocase
        $b3 = "Shell(" ascii nocase
        $b4 = "PowerShell" ascii nocase
        $b5 = "cmd.exe" ascii nocase

    condition:
        any of ($a*) and any of ($b*)
}
