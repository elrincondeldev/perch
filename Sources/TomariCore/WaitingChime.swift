import Foundation

/// Decides when a session that starts waiting for the user earns a chime: only a live transition into
/// needs_permission or needs_input from any other state, once per burst, and not while the user is
/// already looking at it (it is focused and Terminal or the Claude desktop app is in front).
public struct WaitingChime: Sendable {
    /// Sessions starting to wait within this window of a chime share it.
    public static let burst: TimeInterval = 1

    private var lastChime: Date?

    public init() {}

    /// `previous` is the session as it was before `message` was applied.
    public mutating func shouldChime(
        for message: ServerMessage,
        previous: PanelSession?,
        focusedId: String?,
        frontApp: FrontAppKind,
        at now: Date
    ) -> Bool {
        guard case .session(let session) = message, session.needsAttention,
              let before = previous?.state, before != .needsPermission, before != .needsInput
        else { return false }
        if frontApp.showsSessions && session.id == focusedId { return false }
        if let lastChime, now.timeIntervalSince(lastChime) < Self.burst { return false }
        lastChime = now
        return true
    }
}
