#![allow(clippy::disallowed_macros, clippy::print_stdout)]

use std::hint::black_box;
use std::time::{Duration, Instant};

use stella_document_rules_core::{
  BlockId, Document, DocumentBlock, DocumentChange, DocumentPatch,
  IncrementalDocumentSession, Result, RuleEngine, RuleSet,
};

const ITERATIONS: u32 = 1_000;
const DOCUMENT_SIZES: &[usize] = &[1_000, 20_000];

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
  println!("blocks\tpatch\tpatch+analyze");
  for block_count in DOCUMENT_SIZES {
    let patch = measure_patch(*block_count, ITERATIONS)?;
    let end_to_end = measure_patch_and_analyze(*block_count, ITERATIONS)?;
    println!("{block_count}\t{patch:?}\t{end_to_end:?}");
  }
  Ok(())
}

fn measure_patch(
  block_count: usize,
  iterations: u32,
) -> std::result::Result<Duration, Box<dyn std::error::Error>> {
  let mut session = session(block_count)?;
  black_box(session.analyze()?);
  let target = BlockId::new(format!("block-{}", block_count.div_ceil(2)))?;
  let started = Instant::now();
  for iteration in 0..iterations {
    apply_alternating_patch(&mut session, &target, iteration)?;
  }
  let elapsed = started.elapsed();
  black_box(session.analyze()?);
  Ok(average_duration(elapsed, iterations)?)
}

fn measure_patch_and_analyze(
  block_count: usize,
  iterations: u32,
) -> std::result::Result<Duration, Box<dyn std::error::Error>> {
  let mut session = session(block_count)?;
  black_box(session.analyze()?);
  let target = BlockId::new(format!("block-{}", block_count.div_ceil(2)))?;
  let started = Instant::now();
  for iteration in 0..iterations {
    apply_alternating_patch(&mut session, &target, iteration)?;
    black_box(session.analyze()?);
  }
  Ok(average_duration(started.elapsed(), iterations)?)
}

fn average_duration(
  duration: Duration,
  iterations: u32,
) -> std::io::Result<Duration> {
  duration.checked_div(iterations).ok_or_else(|| {
    std::io::Error::new(
      std::io::ErrorKind::InvalidInput,
      "benchmark iterations must be non-zero",
    )
  })
}

fn apply_alternating_patch(
  session: &mut IncrementalDocumentSession,
  target: &BlockId,
  iteration: u32,
) -> Result<()> {
  let text = if iteration.is_multiple_of(2) {
    "changed alpha"
  } else {
    "changed beta"
  };
  session.apply_patch(&DocumentPatch::new(
    session.revision(),
    vec![DocumentChange::replace_text(target.clone(), text)],
  ))?;
  Ok(())
}

fn session(block_count: usize) -> Result<IncrementalDocumentSession> {
  let blocks = (0..block_count)
    .map(|index| {
      DocumentBlock::new(
        BlockId::new(format!("block-{index}"))?,
        "unchanged text",
      )
    })
    .collect::<Result<Vec<_>>>()?;
  let engine = RuleEngine::new(RuleSet::new(Vec::new())?);
  Ok(IncrementalDocumentSession::new(
    &engine,
    Document::new(blocks)?,
  ))
}
