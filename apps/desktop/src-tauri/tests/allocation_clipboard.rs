mod allocation_support;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

#[test]
fn owned_clipboard_writes_do_not_copy_the_payload() {
  allocation_support::census();
  for size in allocation_support::SIZES {
    let text = "x".repeat(size);
    let profiler = dhat::Profiler::builder().testing().build();
    stella_desktop_lib::clipboard_allocation_harness::write(text);
    let stats = dhat::HeapStats::get();
    // Only the one-element contents vector is allocated; the text is moved.
    assert_eq!(stats.total_blocks, 1, "{size}: {stats:?}");
    assert!(stats.max_bytes <= size, "{size}: {stats:?}");
    assert_eq!(stats.curr_blocks, 0, "{size}: {stats:?}");
    drop(profiler);
    println!(
      "clipboard size={size} allocations={} peak={}",
      stats.total_blocks, stats.max_bytes
    );
  }
}
