mod allocation_support;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

#[test]
fn unchanged_sessions_neither_read_nor_allocate_payloads() {
  allocation_support::census();
  for size in allocation_support::SIZES {
    let fixture = stella_desktop_lib::session_allocation_harness::Fixture::new(size);
    fixture.retry();
    let profiler = dhat::Profiler::builder().testing().build();
    for _ in 0..4 {
      fixture.retry();
    }
    let stats = dhat::HeapStats::get();
    assert_eq!(
      fixture.reads(),
      0,
      "unchanged files must not be read or hashed"
    );
    assert_eq!(stats.total_blocks, 0, "{size}: {stats:?}");
    assert_eq!(stats.max_bytes, 0, "{size}: {stats:?}");
    assert_eq!(stats.curr_blocks, 0, "{size}: {stats:?}");
    drop(profiler);
    println!("session gate size={size} reads=0 allocations=0 peak=0");

    fixture.invalidate_observation();
    let profiler = dhat::Profiler::builder().testing().build();
    fixture.retry();
    fixture.retry();
    let stats = dhat::HeapStats::get();
    assert_eq!(
      fixture.reads(),
      1,
      "changed metadata reads/hashes equal content exactly once"
    );
    assert_eq!(stats.total_blocks, 10, "{size}: {stats:?}");
    assert!(stats.max_bytes <= size + 512, "{size}: {stats:?}");
    // The newly computed digest replaces the session's observed hash.
    assert_eq!(stats.curr_bytes, 64, "{size}: {stats:?}");
    drop(fixture);
    let freed = dhat::HeapStats::get();
    assert_eq!(freed.curr_blocks, 0, "{freed:?}");
    drop(profiler);
    println!(
      "session hash size={size} reads=1 allocations={} peak={}",
      stats.total_blocks, stats.max_bytes
    );
  }
}
