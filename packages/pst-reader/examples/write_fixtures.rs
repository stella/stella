//! Writes the committed fixtures from the assembler:
//! `cargo run --example write-fixtures --features assemble`.

use std::{fs, io, path::Path};

use stella_pst_reader::assemble::{assemble, fixtures};

fn main() -> io::Result<()> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    fs::write(
        directory.join("law-firm.pst"),
        assemble(&fixtures::law_firm()),
    )
}
