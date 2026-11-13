import Foundation

public struct SessionList: Equatable, Sendable {
    public private(set) var sessions: [String: PanelSession] = [:]
    public private(set) var focusedId: String?
    /// Where the agent opens sessions; nil until it says, and with an agent that predates hosts.
    public private(set) var host: SessionHost?

    public init() {}

    public mutating func apply(_ message: ServerMessage) {
        switch message {
        case .snapshot(let all, let focused, let host):
            self.host = host
            sessions = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            focusedId = focused
        case .session(let session):
            sessions[session.id] = session
        case .removed(let id):
            sessions[id] = nil
        case .focus(let id):
            focusedId = id
        case .host(let host):
            self.host = host
        case .error, .library:
            break
        }
    }

    /// Pinned sessions, then the active unpinned ones by name rather than activity, so creatures
    /// don't jump around as their states change.
    public func shown(at now: Date) -> [PanelSession] {
        let pinned = sessions.values.filter(\.pinned).sorted {
            ($0.position ?? 0, $0.id) < ($1.position ?? 0, $1.id)
        }
        let others = sessions.values.filter { !$0.pinned && $0.isActive(at: now) }.sorted {
            let order = $0.name.localizedCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
        return pinned + others
    }
}
