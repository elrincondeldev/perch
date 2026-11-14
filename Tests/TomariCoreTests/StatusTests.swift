import Foundation
import TomariCore

func statusTests() {
    test("maps states to moods") {
        expectEqual(session(state: .working).mood(at: now), .working)
        expectEqual(session(state: .needsPermission).mood(at: now), .alert)
        expectEqual(session(state: .needsInput).mood(at: now), .asking)
        expectEqual(session(state: .compacting).mood(at: now), .compacting)
        expectEqual(session(state: .error).mood(at: now), .error)
        expectEqual(session(state: .ended).mood(at: now), .sleeping)
    }

    test("a finished session waits for you, then dozes off after five minutes") {
        expectEqual(session(state: .done, stateSince: now - 60).mood(at: now), .finished)
        expectEqual(session(state: .idle, stateSince: now - 60).mood(at: now), .idle)
        expectEqual(session(state: .done, stateSince: now - 6 * 60).mood(at: now), .sleeping)
    }

    test("active: working or waiting on the user, or finished less than five minutes ago") {
        for state in [SessionState.working, .compacting, .needsPermission, .needsInput] {
            expect(session(state: state).isActive(at: now), "\(state)")
        }
        expect(session(state: .done, stateSince: now - 60).isActive(at: now))
        expect(session(state: .error, stateSince: now - 60).isActive(at: now))
        expect(!session(state: .done, stateSince: now - 6 * 60).isActive(at: now))
        expect(!session(state: .error, stateSince: now - 6 * 60).isActive(at: now))
        expect(!session(state: .idle).isActive(at: now))
        expect(!session(state: .ended, live: false).isActive(at: now))
        expect(!session(state: .working, live: false).isActive(at: now), "its process is gone")
    }

    test("only permission and input requests need the user") {
        let needy = SessionState.allCases.filter { session(state: $0).needsAttention }
        expectEqual(needy, [.needsPermission, .needsInput])
    }

    test("summarises the strip for its tab") {
        expectEqual(summary(of: []), "no sessions")
        expectEqual(summary(of: [session(state: .working)]), "1 session")
        expectEqual(summary(of: [session(state: .working), session(state: .done)]), "2 sessions")
        expectEqual(summary(of: [session(state: .needsInput), session(state: .working)]), "1 needs you")
        expectEqual(summary(of: [session(state: .needsInput), session(state: .needsPermission)]), "2 need you")
    }

    test("ago") {
        expectEqual(ago(since: now, now: now), "now")
        expectEqual(ago(since: now + 30, now: now), "now")
        expectEqual(ago(since: now - 42, now: now), "42s")
        expectEqual(ago(since: now - 5 * 60, now: now), "5m")
        expectEqual(ago(since: now - 3 * 3600, now: now), "3h")
        expectEqual(ago(since: now - 2 * 86400, now: now), "2d")
    }

    test("elapsed") {
        expectEqual(elapsed(since: now, now: now), "<1m")
        expectEqual(elapsed(since: now - 59, now: now), "<1m")
        expectEqual(elapsed(since: now + 30, now: now), "<1m")
        expectEqual(elapsed(since: now - 60, now: now), "1m")
        expectEqual(elapsed(since: now - 4 * 60 - 59, now: now), "4m")
        expectEqual(elapsed(since: now - 59 * 60 - 59, now: now), "59m")
        expectEqual(elapsed(since: now - 3600, now: now), "1h")
        expectEqual(elapsed(since: now - 3600 - 5 * 60, now: now), "1h 5m")
        expectEqual(elapsed(since: now - 23 * 3600 - 59 * 60, now: now), "23h 59m")
        expectEqual(elapsed(since: now - 86400, now: now), "1d")
        expectEqual(elapsed(since: now - 86400 - 3 * 3600 - 20 * 60, now: now), "1d 3h")
    }

    test("statusLine") {
        expectEqual(session(state: .working, activity: "Bash: npm test", stateSince: now - 4 * 60).statusLine(at: now), "Bash: npm test · 4m")
        expectEqual(session(state: .working, stateSince: now - 4 * 60).statusLine(at: now), "working · 4m")
        expectEqual(session(state: .working).statusLine(at: now), "working · <1m")
        expectEqual(session(state: .done, stateSince: now - 5 * 60).statusLine(at: now), "done · 5m")
        expectEqual(session(state: .idle, stateSince: now - 42).statusLine(at: now), "idle · 42s")
        expectEqual(session(state: .ended, live: false, stateSince: now - 2 * 3600).statusLine(at: now), "closed · 2h")
        expectEqual(
            session(state: .needsPermission, activity: "Claude needs your permission to use Bash", stateSince: now - 90).statusLine(at: now),
            "needs permission · 1m"
        )
        expectEqual(session(state: .needsInput, stateSince: now - 2 * 60).statusLine(at: now), "waiting for you · 2m")
        expectEqual(session(state: .needsInput, activity: "Plan ready", stateSince: now - 3600 - 5 * 60).statusLine(at: now), "Plan ready · 1h 5m")
        expectEqual(session(state: .compacting, stateSince: now - 70).statusLine(at: now), "compacting · 1m")
        expectEqual(session(state: .error).statusLine(at: now), "error")
        expectEqual(session(state: .error, activity: "rate limited").statusLine(at: now), "error · rate limited")
    }
}
