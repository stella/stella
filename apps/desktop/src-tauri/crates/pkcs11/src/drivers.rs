//! The PKCS #11 modules the desktop looks for, and where their vendors
//! install them.
//!
//! The list is curated, not discovered: a module is native code loaded into
//! the helper, so only paths a known vendor's installer writes are tried.
//! Each entry names the vendor (for the dialog) and the page its driver is
//! downloaded from (for a driver that needs an update).
//!
//! Module paths are what each vendor's current macOS installer writes,
//! checked against its installation guide where one names the path, and
//! against the MIT-licensed driver lists of Web eID (`libelectronic-id`) and
//! Peculiar Ventures' `webcrypto-local` (`packages/cards/lib/card.json`).

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::macho::{Architecture, HEADER_BYTES, ModuleCheck, check_module};

/// A vendor's PKCS #11 driver.
#[derive(Debug, Eq, PartialEq)]
pub struct KnownDriver {
  /// Stable, for the dialog to name the driver it is talking about.
  pub id: &'static str,
  /// As the vendor names the product.
  pub vendor: &'static str,
  /// Where the vendor's macOS installer puts the module, most current first.
  pub macos_modules: &'static [&'static str],
  /// The vendor's own download page.
  pub download_url: &'static str,
}

/// Every driver the desktop tries, vendor drivers first: a vendor's module
/// knows its own cards best, so when a generic one (OpenSC) sees the same
/// certificate, the vendor's entry is the one kept.
pub const KNOWN_DRIVERS: &[KnownDriver] = &[
  KnownDriver {
    id: "ica-securestore",
    vendor: "I.CA SecureStore",
    macos_modules: &["/usr/local/lib/pkcs11/libICASecureStorePkcs11.dylib"],
    download_url: "https://www.ica.cz/secure-store",
  },
  KnownDriver {
    id: "cz-eop",
    vendor: "eObčanka",
    // The proxy module serves every generation of the card.
    macos_modules: &["/usr/local/lib/eOPCZE/libeopproxyp11.dylib"],
    download_url: "https://info.identita.gov.cz/download/Default.aspx",
  },
  KnownDriver {
    id: "sk-eid",
    vendor: "eID klient",
    macos_modules: &[
      "/Applications/eID_klient.app/Contents/Frameworks/libPkcs11.dylib",
    ],
    download_url: "https://eidas.minv.sk/download",
  },
  KnownDriver {
    id: "thales-safenet",
    vendor: "SafeNet Authentication Client",
    macos_modules: &["/usr/local/lib/libeTPkcs11.dylib"],
    download_url: "https://cpl.thalesgroup.com/access-management/security-applications/authentication-client-token-management",
  },
  KnownDriver {
    id: "bit4id",
    vendor: "Bit4id Universal Middleware",
    // The installer links its module here from its own directory.
    macos_modules: &["/usr/local/lib/libbit4xpki.dylib"],
    // Bit4id publishes the installer itself rather than a page about it.
    download_url: "https://cdn.bit4id.com/es/soporte/downloads/middleware/Bit4id_Middleware.dmg",
  },
  KnownDriver {
    id: "opensc",
    vendor: "OpenSC",
    // The installer copies its module here beside its own directory; it
    // also reads DNIe cards.
    macos_modules: &["/usr/local/lib/opensc-pkcs11.so"],
    download_url: "https://github.com/OpenSC/OpenSC/releases",
  },
];

/// The driver whose `id` this is, for an action the dialog names by it.
#[must_use]
pub fn known_driver(id: &str) -> Option<&'static KnownDriver> {
  KNOWN_DRIVERS.iter().find(|driver| driver.id == id)
}

/// An installed module, as found on disk.
#[derive(Debug, Eq, PartialEq)]
pub struct InstalledModule {
  pub driver: &'static KnownDriver,
  /// With symbolic links resolved: one file reached by two listed paths is
  /// loaded once.
  pub path: PathBuf,
  pub check: ModuleCheck,
}

/// The head of a module file and its resolved path, or `None` when nothing
/// readable is there. The seam the tests replace.
pub type ReadModuleHead<'a> = &'a dyn Fn(&Path) -> Option<(PathBuf, Vec<u8>)>;

/// Every known module installed on this computer, in [`KNOWN_DRIVERS`]
/// order, each checked against the processor this build runs on.
#[must_use]
pub fn installed_modules() -> Vec<InstalledModule> {
  installed_modules_with(KNOWN_DRIVERS, &read_module_head, Architecture::current())
}

pub fn installed_modules_with(
  drivers: &'static [KnownDriver],
  read_head: ReadModuleHead<'_>,
  wanted: Architecture,
) -> Vec<InstalledModule> {
  let mut installed: Vec<InstalledModule> = Vec::new();
  for driver in drivers {
    for listed in driver.macos_modules {
      let Some((path, head)) = read_head(Path::new(listed)) else {
        continue;
      };
      if installed.iter().any(|module| module.path == path) {
        continue;
      }
      installed.push(InstalledModule {
        driver,
        path,
        check: check_module(&head, wanted),
      });
      // A driver's later paths are older locations of the same module.
      break;
    }
  }
  installed
}

/// A regular file's resolved path and leading bytes.
fn read_module_head(path: &Path) -> Option<(PathBuf, Vec<u8>)> {
  let resolved = std::fs::canonicalize(path).ok()?;
  let file = File::open(&resolved).ok()?;
  if !file.metadata().ok()?.is_file() {
    return None;
  }
  let mut head = Vec::with_capacity(HEADER_BYTES);
  let limit = u64::try_from(HEADER_BYTES).ok()?;
  file.take(limit).read_to_end(&mut head).ok()?;
  Some((resolved, head))
}

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use super::*;

  const ARM64_MODULE: &[u8] = &[
    0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  ];
  const INTEL_MODULE: &[u8] = &[
    0xCF, 0xFA, 0xED, 0xFE, 0x07, 0x00, 0x00, 0x01, 0x03, 0x00, 0x00, 0x00,
  ];

  static DRIVERS: &[KnownDriver] = &[
    KnownDriver {
      id: "vendor",
      vendor: "Vendor",
      macos_modules: &["/vendor/new.dylib", "/vendor/old.dylib"],
      download_url: "https://vendor.example/download",
    },
    KnownDriver {
      id: "intel-only",
      vendor: "Intel only",
      macos_modules: &["/intel/module.dylib"],
      download_url: "https://intel-only.example/download",
    },
    KnownDriver {
      id: "generic",
      vendor: "Generic",
      macos_modules: &["/generic/link.so", "/generic/module.so"],
      download_url: "https://generic.example/download",
    },
  ];

  fn disk(
    files: &[(&str, &str, &'static [u8])],
  ) -> HashMap<PathBuf, (PathBuf, Vec<u8>)> {
    files
      .iter()
      .map(|(listed, resolved, head)| {
        (
          PathBuf::from(listed),
          (PathBuf::from(resolved), head.to_vec()),
        )
      })
      .collect()
  }

  #[test]
  fn finds_each_installed_driver_once_in_table_order() {
    let files = disk(&[
      ("/vendor/old.dylib", "/vendor/old.dylib", ARM64_MODULE),
      ("/intel/module.dylib", "/intel/module.dylib", INTEL_MODULE),
      // The generic driver installs a link to its module as well.
      ("/generic/link.so", "/generic/module.so", ARM64_MODULE),
      ("/generic/module.so", "/generic/module.so", ARM64_MODULE),
    ]);
    let found = installed_modules_with(
      DRIVERS,
      &|path| files.get(path).cloned(),
      Architecture::Arm64,
    );

    let summary: Vec<(&str, &Path, &ModuleCheck)> = found
      .iter()
      .map(|module| (module.driver.id, module.path.as_path(), &module.check))
      .collect();
    assert_eq!(
      summary,
      vec![
        (
          "vendor",
          Path::new("/vendor/old.dylib"),
          &ModuleCheck::Loadable
        ),
        (
          "intel-only",
          Path::new("/intel/module.dylib"),
          &ModuleCheck::MissingArchitecture {
            found: vec![Architecture::X86_64]
          }
        ),
        (
          "generic",
          Path::new("/generic/module.so"),
          &ModuleCheck::Loadable
        ),
      ]
    );
  }

  #[test]
  fn one_file_reached_from_two_drivers_is_loaded_once() {
    let files = disk(&[
      ("/vendor/new.dylib", "/shared/module.dylib", ARM64_MODULE),
      ("/generic/link.so", "/shared/module.dylib", ARM64_MODULE),
    ]);
    let found = installed_modules_with(
      DRIVERS,
      &|path| files.get(path).cloned(),
      Architecture::Arm64,
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].driver.id, "vendor");
  }

  #[test]
  fn the_table_is_well_formed() {
    let mut ids: Vec<&str> = KNOWN_DRIVERS.iter().map(|driver| driver.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), KNOWN_DRIVERS.len(), "driver ids are unique");
    for driver in KNOWN_DRIVERS {
      assert!(driver.download_url.starts_with("https://"), "{}", driver.id);
      assert!(!driver.macos_modules.is_empty(), "{}", driver.id);
      for module in driver.macos_modules {
        assert!(Path::new(module).is_absolute(), "{module}");
      }
      assert_eq!(known_driver(driver.id), Some(driver));
    }
    assert_eq!(known_driver("unknown"), None);
    // The generic driver comes last, so a vendor's own module wins a tie.
    assert_eq!(KNOWN_DRIVERS.last().map(|driver| driver.id), Some("opensc"));
  }

  #[test]
  fn reads_nothing_where_no_file_is() {
    assert!(read_module_head(Path::new("/nonexistent/stella/module.dylib")).is_none());
  }
}
