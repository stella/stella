//! Whether a module can load into this process at all, read from its
//! Mach-O header before anything loads it.
//!
//! A driver built only for Intel cannot load into an Apple silicon process
//! (Rosetta translates whole processes, not libraries), and `dlopen` would
//! only say "incompatible architecture". Reading the header first lets the
//! dialog tell the user the driver needs an update, and keeps a module that
//! cannot load out of the helper.

/// `mach/machine.h`.
const CPU_ARCH_ABI64: u32 = 0x0100_0000;
const CPU_TYPE_X86: u32 = 7;
const CPU_TYPE_ARM: u32 = 12;
const CPU_TYPE_X86_64: u32 = CPU_TYPE_X86 | CPU_ARCH_ABI64;
const CPU_TYPE_ARM64: u32 = CPU_TYPE_ARM | CPU_ARCH_ABI64;
/// The capability bits in the top byte of a subtype.
const CPU_SUBTYPE_MASK: u32 = 0xFF00_0000;
/// arm64e: pointer authentication, a different ABI that an arm64 process
/// cannot load.
const CPU_SUBTYPE_ARM64E: u32 = 2;

/// `mach-o/loader.h` and `mach-o/fat.h`. A thin header's magic is in the
/// file's byte order; a universal header is always big-endian.
const MH_MAGIC: u32 = 0xFEED_FACE;
const MH_MAGIC_64: u32 = 0xFEED_FACF;
const FAT_MAGIC: u32 = 0xCAFE_BABE;
const FAT_MAGIC_64: u32 = 0xCAFE_BABF;
const FAT_ARCH_SIZE: usize = 20;
const FAT_ARCH_64_SIZE: usize = 32;
/// A universal file holds a handful of slices; a "count" past this is a
/// Java class file (which shares the magic) or garbage.
const MAX_FAT_ARCHS: u32 = 32;

/// How many leading bytes [`check_module`] needs: a universal header with
/// as many 64-bit entries as a real universal file can hold.
pub const HEADER_BYTES: usize = 8 + FAT_ARCH_64_SIZE * MAX_FAT_ARCHS as usize;

/// A CPU a Mach-O slice runs on, as far as loading it matters here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Architecture {
  Arm64,
  Arm64e,
  X86_64,
  Other,
}

impl Architecture {
  /// The architecture this build runs as, which a module must provide.
  #[must_use]
  pub const fn current() -> Self {
    if cfg!(target_arch = "aarch64") {
      Self::Arm64
    } else if cfg!(target_arch = "x86_64") {
      Self::X86_64
    } else {
      Self::Other
    }
  }

  fn from_cpu(cpu_type: u32, cpu_subtype: u32) -> Self {
    match cpu_type {
      CPU_TYPE_ARM64 if cpu_subtype & !CPU_SUBTYPE_MASK == CPU_SUBTYPE_ARM64E => {
        Self::Arm64e
      }
      CPU_TYPE_ARM64 => Self::Arm64,
      CPU_TYPE_X86_64 => Self::X86_64,
      _ => Self::Other,
    }
  }
}

/// What the header says about loading the module into a process running as
/// `wanted`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleCheck {
  /// A slice for `wanted` is there.
  Loadable,
  /// A Mach-O file, but without a slice for `wanted`: the vendor's driver
  /// predates this machine's processor.
  MissingArchitecture { found: Vec<Architecture> },
  /// Not a Mach-O file.
  NotALibrary,
}

/// Read the header of a module file (its first [`HEADER_BYTES`] bytes, or
/// all of a shorter file).
#[must_use]
pub fn check_module(head: &[u8], wanted: Architecture) -> ModuleCheck {
  let Some(found) = architectures(head) else {
    return ModuleCheck::NotALibrary;
  };
  if found.contains(&wanted) {
    ModuleCheck::Loadable
  } else {
    ModuleCheck::MissingArchitecture { found }
  }
}

fn architectures(head: &[u8]) -> Option<Vec<Architecture>> {
  let magic_be = read_u32_be(head, 0)?;
  match magic_be {
    FAT_MAGIC | FAT_MAGIC_64 => {
      let count = read_u32_be(head, 4)?;
      if count == 0 || count > MAX_FAT_ARCHS {
        return None;
      }
      let entry_size = if magic_be == FAT_MAGIC {
        FAT_ARCH_SIZE
      } else {
        FAT_ARCH_64_SIZE
      };
      (0..count as usize)
        .map(|index| {
          let entry = 8 + index * entry_size;
          Some(Architecture::from_cpu(
            read_u32_be(head, entry)?,
            read_u32_be(head, entry + 4)?,
          ))
        })
        .collect()
    }
    _ => {
      let magic_le = read_u32_le(head, 0)?;
      if magic_le != MH_MAGIC && magic_le != MH_MAGIC_64 {
        return None;
      }
      Some(vec![Architecture::from_cpu(
        read_u32_le(head, 4)?,
        read_u32_le(head, 8)?,
      )])
    }
  }
}

fn word(head: &[u8], offset: usize) -> Option<[u8; 4]> {
  head.get(offset..offset.checked_add(4)?)?.try_into().ok()
}

fn read_u32_be(head: &[u8], offset: usize) -> Option<u32> {
  word(head, offset).map(u32::from_be_bytes)
}

fn read_u32_le(head: &[u8], offset: usize) -> Option<u32> {
  word(head, offset).map(u32::from_le_bytes)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn thin(cpu_type: u32, cpu_subtype: u32) -> Vec<u8> {
    let mut head = Vec::new();
    head.extend_from_slice(&MH_MAGIC_64.to_le_bytes());
    head.extend_from_slice(&cpu_type.to_le_bytes());
    head.extend_from_slice(&cpu_subtype.to_le_bytes());
    head.extend_from_slice(&[0; 20]);
    head
  }

  fn fat(slices: &[(u32, u32)], magic: u32) -> Vec<u8> {
    let entry_size = if magic == FAT_MAGIC {
      FAT_ARCH_SIZE
    } else {
      FAT_ARCH_64_SIZE
    };
    let mut head = Vec::new();
    head.extend_from_slice(&magic.to_be_bytes());
    head.extend_from_slice(&u32::try_from(slices.len()).unwrap().to_be_bytes());
    for (cpu_type, cpu_subtype) in slices {
      let mut entry = vec![0; entry_size];
      entry[..4].copy_from_slice(&cpu_type.to_be_bytes());
      entry[4..8].copy_from_slice(&cpu_subtype.to_be_bytes());
      head.extend_from_slice(&entry);
    }
    head
  }

  #[test]
  fn loads_a_thin_module_built_for_this_processor() {
    assert_eq!(
      check_module(&thin(CPU_TYPE_ARM64, 0), Architecture::Arm64),
      ModuleCheck::Loadable
    );
    assert_eq!(
      check_module(&thin(CPU_TYPE_X86_64, 3), Architecture::X86_64),
      ModuleCheck::Loadable
    );
  }

  #[test]
  fn an_intel_only_driver_needs_an_update_on_apple_silicon() {
    assert_eq!(
      check_module(&thin(CPU_TYPE_X86_64, 3), Architecture::Arm64),
      ModuleCheck::MissingArchitecture {
        found: vec![Architecture::X86_64]
      }
    );
    assert_eq!(
      check_module(
        &fat(&[(CPU_TYPE_X86_64, 3)], FAT_MAGIC),
        Architecture::Arm64
      ),
      ModuleCheck::MissingArchitecture {
        found: vec![Architecture::X86_64]
      }
    );
  }

  #[test]
  fn finds_the_slice_in_a_universal_module() {
    for magic in [FAT_MAGIC, FAT_MAGIC_64] {
      let universal = fat(&[(CPU_TYPE_X86_64, 3), (CPU_TYPE_ARM64, 0)], magic);
      assert_eq!(
        check_module(&universal, Architecture::Arm64),
        ModuleCheck::Loadable
      );
      assert_eq!(
        check_module(&universal, Architecture::X86_64),
        ModuleCheck::Loadable
      );
    }
  }

  #[test]
  fn an_arm64e_only_module_cannot_load_into_an_arm64_process() {
    // The capability bits in the subtype's top byte do not change the ABI.
    let arm64e = thin(CPU_TYPE_ARM64, 0x8000_0000 | CPU_SUBTYPE_ARM64E);
    assert_eq!(
      check_module(&arm64e, Architecture::Arm64),
      ModuleCheck::MissingArchitecture {
        found: vec![Architecture::Arm64e]
      }
    );
  }

  #[test]
  fn refuses_what_is_not_mach_o() {
    for head in [
      b"".as_slice(),
      b"\x7fELF\x02\x01\x01\0",
      b"MZ\x90\0",
      // A Java class file shares the universal magic; its "count" is the
      // class file version.
      &[0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x00, 0x00, 0x41],
      // A universal header cut short.
      &fat(&[(CPU_TYPE_ARM64, 0)], FAT_MAGIC)[..12],
    ] {
      assert_eq!(
        check_module(head, Architecture::Arm64),
        ModuleCheck::NotALibrary,
        "{head:?}"
      );
    }
  }

  #[test]
  fn the_header_budget_covers_the_largest_universal_header() {
    let slices = vec![(CPU_TYPE_ARM64, 0); MAX_FAT_ARCHS as usize];
    assert_eq!(fat(&slices, FAT_MAGIC_64).len(), HEADER_BYTES);
  }
}
