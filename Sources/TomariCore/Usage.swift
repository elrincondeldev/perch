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

/// One bar of the limits meter: how much of a window is used.
public struct LimitMeter: Equatable, Sendable {
    public enum Level: Sendable { case ok, warm, hot }

    public var label: String
    /// "44%"
    public var text: String
    /// 0...1
    public var fraction: Double
    /// From the rounded percentage, so the color always agrees with the text: warm from 70 %, hot from 90 %.
    public var level: Level

    public init(label: String, usedPct: Double) {
        let pct = min(max(usedPct, 0), 100)
        let shown = pct.rounded()
        self.label = label
        text = "\(Int(shown))%"
        fraction = pct / 100
        level = shown >= 90 ? .hot : shown >= 70 ? .warm : .ok
    }
}

extension AccountLimits {
    /// A bar for each window that hasn't reset yet, the 5-hour one first.
    public func meters(at now: Date) -> [LimitMeter] {
        guard let live = live(at: now) else { return [] }
        var meters: [LimitMeter] = []
        if let window = live.fiveHour { meters.append(LimitMeter(label: "5h", usedPct: window.usedPct)) }
        if let window = live.sevenDay { meters.append(LimitMeter(label: "7d", usedPct: window.usedPct)) }
        return meters
    }
}

extension DailySpend {
    /// "today · $3.20", or nil once the day it counts is no longer today.
    public func line(at now: Date, calendar: Calendar = .current) -> String? {
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        let today = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        return day == today ? "today · \(costText(usd))" : nil
    }
}

public enum LimitsReport {
    /// What the limits cell says on hover: each window with its reset time, the session in front, today's spend.
    /// Empty when nothing is known.
    public static func lines(limits: AccountLimits?, session: SessionUsage?, spend: DailySpend?, at now: Date, calendar: Calendar = .current) -> [String] {
        var lines: [String] = []
        if let live = limits?.live(at: now) {
            if let window = live.fiveHour { lines.append(window.line("5h", at: now)) }
            if let window = live.sevenDay { lines.append(window.line("7d", at: now)) }
        }
        if let line = session?.line { lines.append("session · \(line)") }
        if let line = spend?.line(at: now, calendar: calendar) { lines.append(line) }
        return lines
    }
}
