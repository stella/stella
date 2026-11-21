mod allocation_support;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

#[test]
fn checkpoints_move_one_file_buffer_and_release_the_manager() {
  allocation_support::census();
  for size in allocation_support::SIZES {
    let fixture = stella_desktop_lib::session_allocation_harness::Fixture::new(size);
    let warm_server = fixture.start_upload();
    fixture.retry();
    warm_server.join().unwrap();
    fixture.reset_reads();
    let server = fixture.start_upload();
    let profiler = dhat::Profiler::builder().testing().build();
    fixture.retry();
    server.join().unwrap();
    let stats = dhat::HeapStats::get();
    assert_eq!(
      fixture.reads(),
      1,
      "the upload fingerprint must prevent a second read/hash"
    );
    // One owned file buffer plus fixed HTTP/runtime/store overhead: at most
    // 1.75 times the payload at S, and 1.075 times at 10S.
    assert!(stats.total_blocks <= 200, "{size}: {stats:?}");
    assert!(stats.max_bytes <= size + 48 * 1024, "{size}: {stats:?}");
    drop(fixture);
    let freed = dhat::HeapStats::get();
    assert_eq!(freed.curr_blocks, 0, "{size}: {freed:?}");
    drop(profiler);
    println!(
      "session upload size={size} reads=1 allocations={} peak={} retained_after_teardown={}",
      stats.total_blocks, stats.max_bytes, freed.curr_bytes
    );
  }
}
