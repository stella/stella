// Accessed only on the capture's serial IO queue. Tickets survive a permission
// prompt, while invalidation prevents its callback from starting after sign-out.
struct CaptureRequestTicket: Equatable {
  fileprivate let generation: UInt64
}

struct CaptureRequests {
  private var generation: UInt64 = 0
  var ticket: CaptureRequestTicket { CaptureRequestTicket(generation: generation) }
  mutating func invalidate() { generation += 1 }
}
