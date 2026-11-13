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
    }

    test("windows that have reset are dropped from the line") {
        let both = AccountLimits(
            fiveHour: LimitWindow(usedPct: 44, resetsAt: now + 100), sevenDay: LimitWindow(usedPct: 39, resetsAt: now + 5000), updatedAt: now)
        expectEqual(both.line(at: now), "5h 44% · 7d 39%")
        expectEqual(both.line(at: now + 200), "7d 39%")
        expectEqual(both.line(at: now + 6000), nil)
        expectEqual(both.live(at: now + 6000), nil)
    }
}
