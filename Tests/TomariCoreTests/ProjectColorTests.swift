import Foundation
import TomariCore

private func inFolder(_ cwd: String, icon: SessionIcon = .default) -> PanelSession {
    var s = session()
    s.cwd = cwd
    s.icon = icon
    return s
}

func projectColorTests() {
    test("the same folder always gets the same color, across calls") {
        let a = ProjectColor.color(forCwd: "/Users/me/code/tomari")
        for _ in 0..<5 { expectEqual(ProjectColor.color(forCwd: "/Users/me/code/tomari"), a) }
        expect(ProjectColor.palette.contains(a))
    }

    test("the hash is fixed, not randomized per process") {
        // Reference FNV-1a 64-bit values.
        expectEqual(ProjectColor.fnv1a(""), 0xcbf29ce484222325)
        expectEqual(ProjectColor.fnv1a("a"), 0xaf63dc4c8601ec8c)
        expectEqual(ProjectColor.fnv1a("foobar"), 0x85944171f73967e8)
    }

    test("different folders spread over the palette") {
        let names = ["tomari", "gastito", "walletpass", "cts-bot", "pomotti", "breathe", "prospector", "braseros", "smile-store", "luz-eterna", "matchic", "postiz"]
        let colors = Set(names.map { ProjectColor.color(forCwd: "/Users/me/\($0)") })
        expect(colors.count >= 4, "got \(colors.count) distinct colors")
    }

    test("sessions in the same repo share a color, worktrees and trailing slashes included") {
        let root = ProjectColor.color(forCwd: "/Users/me/perch")
        expectEqual(ProjectColor.color(forCwd: "/Users/me/perch/"), root)
        expectEqual(ProjectColor.color(forCwd: "/Users/me/perch/.claude/worktrees/terminal-polish"), root)
        expectEqual(ProjectColor.color(forCwd: "/Users/me/perch/.claude/worktrees/other/agent"), root)
    }

    test("an empty folder falls back to a palette color") {
        expect(ProjectColor.palette.contains(ProjectColor.color(forCwd: "")))
    }

    test("a session with the default color takes its project's color when on") {
        let s = inFolder("/Users/me/perch")
        let shown = ProjectColor.icon(for: s, enabled: true)
        expectEqual(shown.color, ProjectColor.color(forCwd: "/Users/me/perch"))
        expectEqual(shown.character, s.icon.character)
    }

    test("a color the user picked always wins") {
        let custom = SessionIcon(character: "ghost", color: "#4f7cff")
        expectEqual(ProjectColor.icon(for: inFolder("/Users/me/perch", icon: custom), enabled: true), custom)
    }

    test("off leaves the icon unchanged") {
        expectEqual(ProjectColor.icon(for: inFolder("/Users/me/perch"), enabled: false), .default)
    }

    test("coloring a session changes only its icon color") {
        let s = inFolder("/Users/me/perch")
        var expected = s
        expected.icon.color = ProjectColor.color(forCwd: "/Users/me/perch")
        expectEqual(s.coloredByProject(true), expected)
        expectEqual(s.coloredByProject(false), s)
    }
}
