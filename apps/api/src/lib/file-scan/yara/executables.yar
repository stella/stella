rule embedded_pe_executable
{
    meta:
        description = "Embedded PE/MZ executable signature found"
        verdict = "suspicious"

    strings:
        $mz = "MZ" ascii
        $pe = "PE\x00\x00" ascii

    condition:
        $mz in (64..filesize) and $pe in (64..filesize)
}

rule embedded_elf
{
    meta:
        description = "Embedded ELF (Linux) executable signature found"
        verdict = "suspicious"

    strings:
        $elf = { 7F 45 4C 46 }

    condition:
        $elf in (64..filesize)
}

rule embedded_macho_64
{
    meta:
        description = "Embedded Mach-O 64-bit executable signature found"
        verdict = "suspicious"

    strings:
        $macho1 = { CF FA ED FE }
        $macho2 = { FE ED FA CF }

    condition:
        ($macho1 in (64..filesize)) or
        ($macho2 in (64..filesize))
}

rule embedded_macho_32
{
    meta:
        description = "Embedded Mach-O 32-bit executable signature found"
        verdict = "suspicious"

    strings:
        $macho1 = { CE FA ED FE }
        $macho2 = { FE ED FA CE }

    condition:
        ($macho1 in (64..filesize)) or
        ($macho2 in (64..filesize))
}
