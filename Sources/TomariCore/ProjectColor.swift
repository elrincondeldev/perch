import Foundation

/// An automatic color per project, so every session in one repo shares a look.
public enum ProjectColor {
    /// Six hues that stay apart from each other and from the default clay on the strip's dark tiles
    /// and under a light appearance. Orange, red and white are left out: orange and red already mean
    /// "needs you" and "error" on the strip.
    public static let palette = ["#4f7cff", "#4cd964", "#a66cff", "#ff5fa2", "#3ccfe6", "#ffd23f"]

    /// The part of `cwd` that names the project: a trailing slash is dropped, and a Claude worktree
    /// (`<repo>/.claude/worktrees/<name>/…`) counts as its repo. Pure string work, no disk access,
    /// so it does not find a git root from a subfolder.
    public static func key(forCwd cwd: String) -> String {
        var path = cwd
        if let range = path.range(of: "/.claude/worktrees/") { path = String(path[..<range.lowerBound]) }
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path
    }

    public static func color(forCwd cwd: String) -> String {
        palette[Int(fnv1a(key(forCwd: cwd)) % UInt64(palette.count))]
    }

    /// FNV-1a, 64 bits, over the UTF-8 bytes. Swift's `hashValue` is randomized per process, so it would
    /// recolor every project at each launch.
    public static func fnv1a(_ text: String) -> UInt64 {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return hash
    }

    /// The icon to draw: the project color when `enabled` and the user never picked one.
    public static func icon(for session: PanelSession, enabled: Bool) -> SessionIcon {
        guard enabled, session.icon.color.lowercased() == SessionIcon.default.color else { return session.icon }
        return SessionIcon(character: session.icon.character, color: color(forCwd: session.cwd))
    }
}

extension PanelSession {
    /// The session as the strip draws it.
    public func coloredByProject(_ enabled: Bool) -> PanelSession {
        var copy = self
        copy.icon = ProjectColor.icon(for: self, enabled: enabled)
        return copy
    }
}
