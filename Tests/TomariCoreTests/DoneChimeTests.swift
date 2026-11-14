import Foundation
import TomariCore

func doneChimeTests() {
    func finished(_ session: PanelSession) -> ServerMessage {
        var done = session
        done.state = .done
        return .session(done)
    }

    test("chimes when a working or compacting session finishes") {
        for state in [SessionState.working, .compacting] {
            var chime = DoneChime()
            let before = session(state: state)
            expect(chime.shouldChime(for: finished(before), previous: before, focusedId: nil, frontApp: .other, at: now), "\(state)")
        }
    }

    test("stays quiet for a snapshot, even of finished sessions") {
        var chime = DoneChime()
        let done = session(state: .done)
        expect(!chime.shouldChime(for: .snapshot(sessions: [done], focusedId: nil), previous: nil, focusedId: nil, frontApp: .other, at: now))
    }

    test("stays quiet for a session that was already done or unknown") {
        var chime = DoneChime()
        let done = session(state: .done)
        expect(!chime.shouldChime(for: .session(done), previous: done, focusedId: nil, frontApp: .other, at: now), "done to done")
        expect(!chime.shouldChime(for: .session(done), previous: nil, focusedId: nil, frontApp: .other, at: now), "new session")
    }

    test("stays quiet for a transition into done from a non-active state") {
        for state in [SessionState.idle, .needsInput, .needsPermission, .error, .ended] {
            var chime = DoneChime()
            let before = session(state: state)
            expect(!chime.shouldChime(for: finished(before), previous: before, focusedId: nil, frontApp: .other, at: now), "\(state)")
        }
    }

    test("stays quiet for any other state change") {
        var chime = DoneChime()
        let before = session(state: .working)
        var next = before
        next.state = .needsInput
        expect(!chime.shouldChime(for: .session(next), previous: before, focusedId: nil, frontApp: .other, at: now))
        expect(!chime.shouldChime(for: .focus(id: before.id), previous: before, focusedId: before.id, frontApp: .other, at: now))
    }

    test("a burst of finishes chimes once, then again after the window") {
        var chime = DoneChime()
        let a = session(state: .working), b = session(state: .working), c = session(state: .working)
        expect(chime.shouldChime(for: finished(a), previous: a, focusedId: nil, frontApp: .other, at: now))
        expect(!chime.shouldChime(for: finished(b), previous: b, focusedId: nil, frontApp: .other, at: now + 0.5))
        expect(chime.shouldChime(for: finished(c), previous: c, focusedId: nil, frontApp: .other, at: now + 1.5))
    }

    test("skips the focused session while Terminal is in front, without using up the burst") {
        var chime = DoneChime()
        let a = session(state: .working), b = session(state: .working)
        expect(!chime.shouldChime(for: finished(a), previous: a, focusedId: a.id, frontApp: .terminal, at: now))
        expect(chime.shouldChime(for: finished(b), previous: b, focusedId: a.id, frontApp: .terminal, at: now + 0.1), "another session")
        var other = DoneChime()
        expect(other.shouldChime(for: finished(a), previous: a, focusedId: a.id, frontApp: .other, at: now), "focused but Terminal not in front")
    }

    test("the Claude desktop app counts like Terminal, any other app does not") {
        var chime = DoneChime()
        let a = session(state: .working)
        expect(!chime.shouldChime(for: finished(a), previous: a, focusedId: a.id, frontApp: .desktop, at: now), "desktop app in front")
        expect(chime.shouldChime(for: finished(a), previous: a, focusedId: nil, frontApp: .desktop, at: now), "another session is focused")
    }
}
