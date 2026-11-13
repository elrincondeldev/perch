import Foundation

private func percentText(_ value: Double) -> String {
    "\(Int(min(max(value, 0), 100).rounded()))%"
}

/// 950, 46k, 1.2M
private func compactCount(_ value: Double) -> String {
    let n = min(max(value, 0), 1e15)
    switch n {
    case ..<1_000: return "\(Int(n))"
    case ..<1_000_000: return "\(Int((n / 1_000).rounded()))k"
    default: return String(format: "%.1fM", n / 1_000_000)
    }
}

private func costText(_ usd: Double) -> String {
    let cost = min(max(usd, 0), 1e9)
    return cost > 0 && cost < 0.01 ? "<$0.01" : String(format: "$%.2f", cost)
}

/// "<1m", "25m", "2h 10m", "3d 5h"
private func untilReset(_ date: Date, from now: Date) -> String {
    let s = Int(min(max(date.timeIntervalSince(now), 0), 10_000_000))
    switch s {
    case ..<60: return "<1m"
    case ..<3600: return "\(s / 60)m"
    case ..<86400: return "\(s / 3600)h \(s % 3600 / 60)m"
    default: return "\(s / 86400)d \(s % 86400 / 3600)h"
    }
}

extension SessionUsage {
    /// "ctx 7% · 46k tok · $0.50", leaving out what the statusline hasn't reported; nil when it reported nothing.
    public var line: String? {
        var parts: [String] = []
        if let contextPct { parts.append("ctx \(percentText(contextPct))") }
        if inputTokens != nil || outputTokens != nil {
            parts.append("\(compactCount((inputTokens ?? 0) + (outputTokens ?? 0))) tok")
        }
        if let costUsd { parts.append(costText(costUsd)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension LimitWindow {
    /// "5h 44% · resets in 2h 10m"
    public func line(_ label: String, at now: Date) -> String {
        "\(label) \(percentText(usedPct)) · resets in \(untilReset(resetsAt, from: now))"
    }
}

extension AccountLimits {
    /// The windows that haven't reset yet, or nil when none is left.
    public func live(at now: Date) -> AccountLimits? {
        var copy = self
        if let window = copy.fiveHour, window.resetsAt <= now { copy.fiveHour = nil }
        if let window = copy.sevenDay, window.resetsAt <= now { copy.sevenDay = nil }
        return copy.fiveHour == nil && copy.sevenDay == nil ? nil : copy
    }

    /// "5h 44% · 7d 39%", or nil when every window has reset.
    public func line(at now: Date) -> String? {
        guard let live = live(at: now) else { return nil }
        var parts: [String] = []
        if let window = live.fiveHour { parts.append("5h \(percentText(window.usedPct))") }
        if let window = live.sevenDay { parts.append("7d \(percentText(window.usedPct))") }
        return parts.joined(separator: " · ")
    }
}
