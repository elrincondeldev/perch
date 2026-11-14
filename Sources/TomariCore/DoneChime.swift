import Foundation

/// Decides when a finished session earns a chime: only a live transition from working or
/// compacting to done, once per burst, and not while the user is already looking at it.
public struct DoneChime: Sendable {
    /// Sessions finishing within this window of a chime share it.
    public static let burst: TimeInterval = 1

    private var lastChime: Date?

    public init() {}

    /// `previous` is the session as it was before `message` was applied.
    public mutating func shouldChime(
        for message: ServerMessage,
        previous: PanelSession?,
        focusedId: String?,
        terminalFrontmost: Bool,
        at now: Date
    ) -> Bool {
        guard case .session(let session) = message, session.state == .done,
              let before = previous?.state, before == .working || before == .compacting
        else { return false }
        if terminalFrontmost && session.id == focusedId { return false }
        if let lastChime, now.timeIntervalSince(lastChime) < Self.burst { return false }
        lastChime = now
        return true
    }
}
