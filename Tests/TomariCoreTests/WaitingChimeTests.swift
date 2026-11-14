import Foundation
import TomariCore

func waitingChimeTests() {
    func entered(_ state: SessionState, _ session: PanelSession) -> ServerMessage {
        var next = session
        next.state = state
        return .session(next)
    }

    test("chimes when a session starts needing permission or input") {
        for waiting in [SessionState.needsPermission, .needsInput] {
            for state in [SessionState.working, .compacting, .idle, .done, .error] {
                var chime = WaitingChime()
                let before = session(state: state)
                expect(chime.shouldChime(for: entered(waiting, before), previous: before, focusedId: nil, frontApp: .other, at: now), "\(state) to \(waiting)")
            }
        }
    }

    test("stays quiet when it switches between the two waiting states or was already waiting") {
        var chime = WaitingChime()
        let asking = session(state: .needsInput)
        expect(!chime.shouldChime(for: entered(.needsPermission, asking), previous: asking, focusedId: nil, frontApp: .other, at: now), "input to permission")
        expect(!chime.shouldChime(for: .session(asking), previous: asking, focusedId: nil, frontApp: .other, at: now), "unchanged")
    }

    test("stays quiet for a snapshot, a session without history and other states") {
        var chime = WaitingChime()
        let waiting = session(state: .needsPermission)
        expect(!chime.shouldChime(for: .snapshot(sessions: [waiting], focusedId: nil), previous: nil, focusedId: nil, frontApp: .other, at: now), "snapshot")
        expect(!chime.shouldChime(for: .session(waiting), previous: nil, focusedId: nil, frontApp: .other, at: now), "new session")
        let working = session(state: .working)
        expect(!chime.shouldChime(for: entered(.done, working), previous: working, focusedId: nil, frontApp: .other, at: now), "done")
    }

    test("a burst of waiting sessions chimes once, then again after the window") {
        var chime = WaitingChime()
        let a = session(state: .working), b = session(state: .working), c = session(state: .working)
        expect(chime.shouldChime(for: entered(.needsInput, a), previous: a, focusedId: nil, frontApp: .other, at: now))
        expect(!chime.shouldChime(for: entered(.needsPermission, b), previous: b, focusedId: nil, frontApp: .other, at: now + 0.5))
        expect(chime.shouldChime(for: entered(.needsInput, c), previous: c, focusedId: nil, frontApp: .other, at: now + 1.5))
    }

    test("skips the focused session while Terminal or the desktop app is in front, without using up the burst") {
        var chime = WaitingChime()
        let a = session(state: .working), b = session(state: .working)
        for app in [FrontAppKind.terminal, .desktop] {
            expect(!chime.shouldChime(for: entered(.needsInput, a), previous: a, focusedId: a.id, frontApp: app, at: now), "focused in \(app)")
        }
        expect(chime.shouldChime(for: entered(.needsInput, b), previous: b, focusedId: a.id, frontApp: .terminal, at: now + 0.1), "another session")
        var other = WaitingChime()
        expect(other.shouldChime(for: entered(.needsInput, a), previous: a, focusedId: a.id, frontApp: .other, at: now), "focused but its app not in front")
    }
}
