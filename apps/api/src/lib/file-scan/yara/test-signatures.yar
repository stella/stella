rule eicar_test_file
{
    meta:
        description = "EICAR anti-malware test file found"
        verdict = "malicious"

    strings:
        $eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" ascii

    condition:
        $eicar
}
