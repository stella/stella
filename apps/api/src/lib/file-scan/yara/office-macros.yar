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
