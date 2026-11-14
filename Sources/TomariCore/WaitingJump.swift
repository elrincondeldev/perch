import Foundation

/// Picks the session the "jump" hotkey should open.
public enum WaitingJump {
    /// Live sessions waiting for the user come first, ordered by how long they have waited, longest first.
    /// With none waiting, the target is the session that finished most recently, so the done chime can be
    /// followed by a jump; background sessions are left out there unless a Terminal tab shows them,
    /// since one with no tab would open a new tab just for browsing. Either way, if the focused session is
    /// in that list the target is the next one after it, wrapping around, so repeated presses visit them
    /// all. Nil when nothing is waiting or finished.
    public static func target(in sessions: [PanelSession], focusedId: String?) -> String? {
        let live = sessions.filter(\.live)
        let waiting = live.filter(\.needsAttention).sorted { ($0.stateSince, $0.id) < ($1.stateSince, $1.id) }
        if !waiting.isEmpty { return next(in: waiting, after: focusedId) }
        let finished = live.filter { $0.state == .done && ($0.kind != "background" || $0.inTab == true) }.sorted { ($0.stateSince, $0.id) > ($1.stateSince, $1.id) }
        return finished.isEmpty ? nil : next(in: finished, after: focusedId)
    }

    private static func next(in ordered: [PanelSession], after focusedId: String?) -> String {
        guard let focused = ordered.firstIndex(where: { $0.id == focusedId }) else { return ordered[0].id }
        return ordered[(focused + 1) % ordered.count].id
    }
}
