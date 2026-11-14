import Foundation

/// What the overlay tells the agent is in front, so the agent only asks Terminal about its tabs while it is.
public enum FrontAppKind: String, Equatable, Sendable {
    case terminal
    case desktop
    case other

    public init(bundleId: String?) {
        switch bundleId {
        case "com.apple.Terminal": self = .terminal
        case "com.anthropic.claudefordesktop": self = .desktop
        default: self = .other
        }
    }
}

/// Lets a kind through only when it differs from the one last sent on this connection.
public struct FrontAppReporter: Sendable {
    private var sent: FrontAppKind?

    public init() {}

    /// The kind to send, or nil if the agent already has it.
    public mutating func next(_ kind: FrontAppKind) -> FrontAppKind? {
        guard kind != sent else { return nil }
        sent = kind
        return kind
    }

    /// A new connection starts knowing nothing.
    public mutating func reset() {
        sent = nil
    }
}
