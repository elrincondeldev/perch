import Foundation
import TomariCore

private let sessionJSON = ##"""
{"id":"34446bd8-0000-0000-0000-000000000001","name":"n","cwd":"/","state":"done","activity":null,"live":true,
 "stateSince":0,"pinned":false,"position":null,"icon":{"character":"default","color":"#d97757"}USAGE}
"""##

private func parseSession(usage: String) -> PanelSession? {
    let json = sessionJSON.replacingOccurrences(of: "USAGE", with: usage)
    guard case .session(let s)? = ServerMessage.parse(#"{"type":"session","session":\#(json)}"#) else { return nil }
    return s
}

func usageTests() {
    test("a session carries its usage when the agent sends it") {
        let s = parseSession(usage: #","usage":{"costUsd":1.25,"contextPct":7,"inputTokens":1000,"outputTokens":null}"#)
        expectEqual(s?.usage, SessionUsage(costUsd: 1.25, contextPct: 7, inputTokens: 1000, outputTokens: nil))
    }

    test("a session from an agent without usage has none, and a block it can't read is dropped, not the session") {
        expectEqual(parseSession(usage: "") != nil, true)
        expectEqual(parseSession(usage: "")?.usage, nil)
        let broken = parseSession(usage: #","usage":{"costUsd":"lots"}"#)
        expectEqual(broken != nil, true)
        expectEqual(broken?.usage, nil)
    }

    test("decodes limits, with either window absent") {
        let json = #"{"type":"limits","limits":{"fiveHour":{"usedPct":44,"resetsAt":4000000000000},"sevenDay":null,"updatedAt":1000}}"#
        guard case .limits(let limits)? = ServerMessage.parse(json) else { return expect(false, "not limits") }
        expectEqual(limits.fiveHour, LimitWindow(usedPct: 44, resetsAt: Date(timeIntervalSince1970: 4_000_000_000)))
        expectEqual(limits.sevenDay, nil)
        expectEqual(limits.updatedAt, Date(timeIntervalSince1970: 1))
        expectEqual(ServerMessage.parse(#"{"type":"limits","limits":{"updatedAt":"x"}}"#), nil)
    }

    test("the list keeps the latest limits, through snapshots") {
        var list = SessionList()
        expectEqual(list.limits, nil)
        let limits = AccountLimits(fiveHour: LimitWindow(usedPct: 10, resetsAt: now + 100), sevenDay: nil, updatedAt: now)
        list.apply(.limits(limits))
        list.apply(.snapshot(sessions: [], focusedId: nil))
        expectEqual(list.limits, limits)
    }

    test("usage line: context, tokens and cost, skipping what is missing") {
        expectEqual(SessionUsage(costUsd: 1.25, contextPct: 7.4, inputTokens: 1000, outputTokens: 20).line, "ctx 7% · 1k tok · $1.25")
        expectEqual(SessionUsage(costUsd: 0.5).line, "$0.50")
        expectEqual(SessionUsage(costUsd: 0.0045).line, "<$0.01")
        expectEqual(SessionUsage(costUsd: 0).line, "$0.00")
        expectEqual(SessionUsage(inputTokens: 950).line, "950 tok")
        expectEqual(SessionUsage(inputTokens: 1_234_567).line, "1.2M tok")
        expectEqual(SessionUsage().line, nil)
    }

    test("usage line survives absurd values") {
        expectEqual(SessionUsage(costUsd: -3, contextPct: 400).line, "ctx 100% · $0.00")
        expect(SessionUsage(inputTokens: 1e30).line != nil)
    }

    test("a limit window says how long until it resets") {
        expectEqual(LimitWindow(usedPct: 44, resetsAt: now + 7800).line("5h", at: now), "5h 44% · resets in 2h 10m")
        expectEqual(LimitWindow(usedPct: 39, resetsAt: now + 3 * 86400 + 5 * 3600).line("7d", at: now), "7d 39% · resets in 3d 5h")
        expectEqual(LimitWindow(usedPct: 5, resetsAt: now + 25 * 60).line("5h", at: now), "5h 5% · resets in 25m")
        expectEqual(LimitWindow(usedPct: 5, resetsAt: now + 30).line("5h", at: now), "5h 5% · resets in <1m")
        expectEqual(LimitWindow(usedPct: 90, resetsAt: now - 5).line("5h", at: now), "5h 0% · no active window")
    }

    test("windows that have reset read as 0 %") {
        let both = AccountLimits(
            fiveHour: LimitWindow(usedPct: 44, resetsAt: now + 100), sevenDay: LimitWindow(usedPct: 39, resetsAt: now + 5000), updatedAt: now)
        expectEqual(both.line(at: now), "5h 44% · 7d 39%")
        expectEqual(both.line(at: now + 200), "5h 0% · 7d 39%")
        expectEqual(both.line(at: now + 6000), "5h 0% · 7d 0%")
        expectEqual(AccountLimits(fiveHour: nil, sevenDay: nil, updatedAt: now).live(at: now), nil)
    }
}

func meterTests() {
    test("a meter is calm below 70 %, warm from 70 %, hot from 90 %, judged on the rounded figure") {
        expectEqual(LimitMeter(label: "5h", usedPct: 44).level, .ok)
        expectEqual(LimitMeter(label: "5h", usedPct: 69.4).level, .ok)
        expectEqual(LimitMeter(label: "5h", usedPct: 69.6).level, .warm)
        expectEqual(LimitMeter(label: "5h", usedPct: 89.6).level, .hot)
        expectEqual(LimitMeter(label: "5h", usedPct: 100).level, .hot)
    }

    test("a meter keeps its text and fill inside 0-100 %") {
        let meter = LimitMeter(label: "7d", usedPct: 39)
        expectEqual(meter.text, "39%")
        expectEqual(meter.fraction, 0.39)
        expectEqual(LimitMeter(label: "7d", usedPct: 250).fraction, 1)
        expectEqual(LimitMeter(label: "7d", usedPct: -4).text, "0%")
    }

    test("an account has a meter for each reported window, 5-hour first, empty once reset") {
        let both = AccountLimits(
            fiveHour: LimitWindow(usedPct: 44, resetsAt: now + 100), sevenDay: LimitWindow(usedPct: 39, resetsAt: now + 5000), updatedAt: now)
        expectEqual(both.meters(at: now).map(\.label), ["5h", "7d"])
        expectEqual(both.meters(at: now).map(\.text), ["44%", "39%"])
        expectEqual(both.meters(at: now + 200).map(\.text), ["0%", "39%"])
        expectEqual(both.meters(at: now + 6000).map(\.text), ["0%", "0%"])
        expectEqual(AccountLimits(fiveHour: nil, sevenDay: nil, updatedAt: now).meters(at: now).count, 0)
    }
}

func spendTests() {
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    // 2026-11-13 12:00 UTC
    let noon = Date(timeIntervalSince1970: 1_794_571_200)

    test("decodes today's spend, and the list keeps the latest") {
        let json = #"{"type":"spend","spend":{"day":"2026-11-13","usd":3.2}}"#
        guard case .spend(let spend)? = ServerMessage.parse(json) else { return expect(false, "not spend") }
        expectEqual(spend, DailySpend(day: "2026-11-13", usd: 3.2))
        expectEqual(ServerMessage.parse(#"{"type":"spend","spend":{"day":3}}"#), nil)

        var list = SessionList()
        expectEqual(list.spend, nil)
        list.apply(.spend(spend))
        list.apply(.snapshot(sessions: [], focusedId: nil))
        expectEqual(list.spend, spend)
    }

    test("spend reads as today's, and not at all once the day has passed") {
        let spend = DailySpend(day: "2026-11-13", usd: 3.2)
        expectEqual(spend.line(at: noon, calendar: utc), "today · $3.20")
        expectEqual(spend.line(at: noon + 86400, calendar: utc), nil)
        expectEqual(DailySpend(day: "2026-11-13", usd: 0.004).line(at: noon, calendar: utc), "today · <$0.01")
    }

    test("the limits report lists windows, the session in front and today's spend") {
        let limits = AccountLimits(
            fiveHour: LimitWindow(usedPct: 44, resetsAt: noon + 7800), sevenDay: LimitWindow(usedPct: 39, resetsAt: noon + 3 * 86400 + 5 * 3600), updatedAt: noon)
        let session = SessionUsage(costUsd: 0.5, contextPct: 7, inputTokens: 1000, outputTokens: 20)
        let spend = DailySpend(day: "2026-11-13", usd: 3.2)
        expectEqual(
            LimitsReport.lines(limits: limits, session: session, spend: spend, at: noon, calendar: utc),
            ["5h 44% · resets in 2h 10m", "7d 39% · resets in 3d 5h", "session · ctx 7% · 1k tok · $0.50", "today · $3.20"]
        )
        expectEqual(LimitsReport.lines(limits: nil, session: nil, spend: spend, at: noon, calendar: utc), ["today · $3.20"])
        expectEqual(LimitsReport.lines(limits: nil, session: nil, spend: nil, at: noon, calendar: utc), [])
    }

    test("the limits cell draws a bar per window, filled to its share, and rings the tile when one is hot") {
        func filled(_ a: CreatureAppearance, row: Int) -> Int { a.pixels[row].compactMap { $0 }.filter { $0 == RGB(r: 217, g: 217, b: 217) }.count }
        let calmCell = CreatureAppearance.limits([LimitMeter(label: "5h", usedPct: 50), LimitMeter(label: "7d", usedPct: 60)], hovered: false)
        expectEqual(calmCell.pixels.count, spriteSize)
        expectEqual(calmCell.pixels[0].count, spriteSize)
        expectEqual(calmCell.tile, Tile())
        // Two bars: tops at row 5 and 14; interior rows are the three below each top.
        expectEqual(filled(calmCell, row: 6), 8)
        expectEqual(filled(calmCell, row: 15), 10)

        let hotCell = CreatureAppearance.limits([LimitMeter(label: "5h", usedPct: 95)], hovered: true)
        expectEqual(hotCell.tile, Tile(fill: .white(0.12), border: .danger))
        expectEqual(CreatureAppearance.limits([], hovered: false).pixels.joined().compactMap { $0 }.count, 0)
    }
}

func staleTests() {
    let now = Date(timeIntervalSince1970: 1_794_571_200)
    let limits = AccountLimits(fiveHour: LimitWindow(usedPct: 44, resetsAt: now + 7800), sevenDay: nil, updatedAt: now)

    test("limits go stale after twelve minutes without news") {
        expectEqual(limits.isStale(at: now + 11 * 60), false)
        expectEqual(limits.isStale(at: now + 13 * 60), true)
    }

    test("stale limits say when they were last confirmed, ahead of the windows") {
        let lines = LimitsReport.lines(limits: limits, session: nil, spend: nil, at: now + 3 * 3600 + 120)
        expectEqual(lines.first, "last update 3h 2m ago")
        expectEqual(lines.count, 2)
        expectEqual(LimitsReport.lines(limits: limits, session: nil, spend: nil, at: now + 60).count, 1)
    }

    test("a stale limits cell is dimmed") {
        let meters = [LimitMeter(label: "5h", usedPct: 44)]
        expectEqual(CreatureAppearance.limits(meters, hovered: false, stale: true).opacity, 0.45)
        expectEqual(CreatureAppearance.limits(meters, hovered: false).opacity, 1)
    }
}
