import Foundation
import TomariCore

func waitingJumpTests() {
    func waiting(_ state: SessionState = .needsPermission, since seconds: TimeInterval, live: Bool = true) -> PanelSession {
        session(state: state, live: live, stateSince: now - seconds)
    }

    test("picks the session that has waited longest, for either waiting state") {
        let newer = waiting(.needsInput, since: 10)
        let oldest = waiting(.needsPermission, since: 300)
        let middle = waiting(.needsInput, since: 60)
        expectEqual(WaitingJump.target(in: [newer, oldest, middle], focusedId: nil), oldest.id)
    }

    test("goes to the next waiting session after the focused one") {
        let a = waiting(since: 300), b = waiting(since: 200), c = waiting(since: 100)
        expectEqual(WaitingJump.target(in: [c, a, b], focusedId: a.id), b.id)
        expectEqual(WaitingJump.target(in: [c, a, b], focusedId: b.id), c.id)
    }

    test("wraps around from the last waiting session to the first") {
        let a = waiting(since: 300), b = waiting(since: 100)
        expectEqual(WaitingJump.target(in: [a, b], focusedId: b.id), a.id)
    }

    test("a lone waiting session that is focused stays the target") {
        let only = waiting(since: 50)
        expectEqual(WaitingJump.target(in: [only], focusedId: only.id), only.id)
    }

    test("a focused session that is not waiting does not shift the order") {
        let busy = session(state: .working)
        let a = waiting(since: 300), b = waiting(since: 100)
        expectEqual(WaitingJump.target(in: [busy, a, b], focusedId: busy.id), a.id)
    }

    test("ignores sessions that are not waiting or not live") {
        let working = session(state: .working, stateSince: now - 900)
        let done = session(state: .done, stateSince: now - 900)
        let dead = waiting(since: 900, live: false)
        let real = waiting(since: 5)
        expectEqual(WaitingJump.target(in: [working, done, dead, real], focusedId: nil), real.id)
    }

    test("returns nil when nothing is waiting or finished") {
        expect(WaitingJump.target(in: [], focusedId: nil) == nil, "empty")
        expect(WaitingJump.target(in: [session(state: .working), waiting(since: 1, live: false)], focusedId: nil) == nil, "none eligible")
    }

    test("with nothing waiting, goes to the session that finished most recently") {
        let older = session(state: .done, stateSince: now - 900)
        let newest = session(state: .done, stateSince: now - 60)
        let busy = session(state: .working, stateSince: now - 5)
        expectEqual(WaitingJump.target(in: [older, busy, newest], focusedId: nil), newest.id)
    }

    test("with nothing waiting, repeated presses go from the newest finished session to older ones") {
        let a = session(state: .done, stateSince: now - 60), b = session(state: .done, stateSince: now - 600)
        expectEqual(WaitingJump.target(in: [b, a], focusedId: a.id), b.id)
        expectEqual(WaitingJump.target(in: [b, a], focusedId: b.id), a.id)
    }

    test("a waiting session wins over one that just finished") {
        let justDone = session(state: .done, stateSince: now - 1)
        let asking = waiting(since: 600)
        expectEqual(WaitingJump.target(in: [justDone, asking], focusedId: nil), asking.id)
    }

    test("the finished fallback skips background sessions with no tab, which would open a new one") {
        let background = session(state: .done, stateSince: now - 10, kind: "background", inTab: false)
        let unknown = session(state: .done, stateSince: now - 20, kind: "background")
        let terminal = session(state: .done, stateSince: now - 600)
        expectEqual(WaitingJump.target(in: [background, unknown, terminal], focusedId: nil), terminal.id)
        expect(WaitingJump.target(in: [background, unknown], focusedId: nil) == nil, "only untabbed background")
    }

    test("the finished fallback includes a background session shown in a tab") {
        let tabbed = session(state: .done, stateSince: now - 10, kind: "background", inTab: true)
        let terminal = session(state: .done, stateSince: now - 600)
        expectEqual(WaitingJump.target(in: [terminal, tabbed], focusedId: nil), tabbed.id)
        expectEqual(WaitingJump.target(in: [terminal, tabbed], focusedId: tabbed.id), terminal.id)
    }

    test("a tabbed background session that is still working is not a finished target") {
        let busy = session(state: .working, kind: "background", inTab: true)
        expect(WaitingJump.target(in: [busy], focusedId: nil) == nil, "working")
    }

    test("a waiting background session is still a target") {
        var asking = waiting(since: 60)
        asking.kind = "background"
        expectEqual(WaitingJump.target(in: [asking], focusedId: nil), asking.id)
    }

    test("finished sessions that are no longer live are skipped") {
        let gone = session(state: .done, live: false, stateSince: now - 10)
        expect(WaitingJump.target(in: [gone], focusedId: nil) == nil, "not live")
    }
}
