//! Writes a generated mailbox for measurements:
//! `cargo run --release --example large-mailbox --features assemble -- <out.pst> <messages> <folders> <attachment bytes>`.

use std::{env, fs, io};

use stella_pst_reader::assemble::{assemble, fixtures};

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let [out, count, folders, attachment] = args.as_slice() else {
        return Err(io::Error::other(
            "usage: large-mailbox <out.pst> <messages> <folders> <attachment bytes>",
        ));
    };
    let number = |value: &str| {
        value
            .parse::<usize>()
            .map_err(|_| io::Error::other(format!("not a number: {value}")))
    };
    let mailbox = fixtures::large(number(count)?, number(folders)?, number(attachment)?);
    fs::write(out, assemble(&mailbox))
}
