import Foundation

private let dozeAfter: TimeInterval = 5 * 60

extension PanelSession {
    public var needsAttention: Bool {
        state == .needsPermission || state == .needsInput
    }

    /// Only a live background session can be stopped from the strip.
    public var canStop: Bool {
        live && kind == "background"
    }

    /// Stopping interrupts the current turn when the session is busy or waiting on the user.
    public var stopNeedsConfirmation: Bool {
        switch state {
        case .working, .compacting, .needsPermission, .needsInput: return true
        case .idle, .done, .error, .ended: return false
        }
    }

    /// Doing something or waiting on the user, or finished recently: the strip shows these even unpinned.
    public func isActive(at now: Date) -> Bool {
        guard live else { return false }
        switch state {
        case .working, .compacting, .needsPermission, .needsInput: return true
        case .done, .error: return now.timeIntervalSince(stateSince) <= dozeAfter
        case .idle, .ended: return false
        }
    }

    public func mood(at now: Date) -> Mood {
        switch state {
        case .working: return .working
        case .needsPermission: return .alert
        case .needsInput: return .asking
        case .compacting: return .compacting
        case .error: return .error
        case .ended: return .sleeping
        case .idle: return now.timeIntervalSince(stateSince) > dozeAfter ? .sleeping : .idle
        case .done: return now.timeIntervalSince(stateSince) > dozeAfter ? .sleeping : .finished
        }
    }

    public func statusLine(at now: Date) -> String {
        switch state {
        case .working: return "\(activity ?? "working") · \(elapsed(since: stateSince, now: now))"
        case .needsPermission: return "needs permission · \(elapsed(since: stateSince, now: now))"
        case .needsInput: return "\(activity ?? "waiting for you") · \(elapsed(since: stateSince, now: now))"
        case .compacting: return "compacting · \(elapsed(since: stateSince, now: now))"
        case .error: return activity.map { "error · \($0)" } ?? "error"
        case .idle, .done: return "\(state.rawValue) · \(ago(since: stateSince, now: now))"
        case .ended: return "closed · \(ago(since: stateSince, now: now))"
        }
    }
}

/// What the strip holds, as the tab's status line.
public func summary(of sessions: [PanelSession]) -> String {
    let needy = sessions.filter(\.needsAttention).count
    if needy > 0 { return "\(needy) need\(needy == 1 ? "s" : "") you" }
    switch sessions.count {
    case 0: return "no sessions"
    case 1: return "1 session"
    default: return "\(sessions.count) sessions"
    }
}

public func ago(since: Date, now: Date) -> String {
    let s = max(0, Int(now.timeIntervalSince(since)))
    switch s {
    case ..<5: return "now"
    case ..<60: return "\(s)s"
    case ..<3600: return "\(s / 60)m"
    case ..<86400: return "\(s / 3600)h"
    default: return "\(s / 86400)d"
    }
}

/// How long something has lasted, compact: "<1m", "4m", "1h 5m", "1d 3h".
public func elapsed(since: Date, now: Date) -> String {
    let minutes = max(0, Int(now.timeIntervalSince(since))) / 60
    switch minutes {
    case 0: return "<1m"
    case ..<60: return "\(minutes)m"
    case ..<1440:
        let (h, m) = minutes.quotientAndRemainder(dividingBy: 60)
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    default:
        let (d, rest) = minutes.quotientAndRemainder(dividingBy: 1440)
        let h = rest / 60
        return h == 0 ? "\(d)d" : "\(d)d \(h)h"
    }
}
