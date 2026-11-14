import Foundation
import TomariCore

private let sessionJSON = """
{"id":"34446bd8-0000-0000-0000-000000000001","name":"Node migration","cwd":"/src/app","state":"needs_permission",
 "activity":"Bash: npm test","live":true,"stateSince":5000000,"pinned":true,"position":2,
 "icon":{"character":"ghost","color":"#4f7cff"}}
"""

func protocolTests() {
    test("decodes a session with every field") {
        guard case .session(let s)? = ServerMessage.parse(#"{"type":"session","session":\#(sessionJSON)}"#) else {
            return expect(false, "not a session message")
        }
        expectEqual(s.id, "34446bd8-0000-0000-0000-000000000001")
        expectEqual(s.name, "Node migration")
        expectEqual(s.state, .needsPermission)
        expectEqual(s.activity, "Bash: npm test")
        expectEqual(s.live, true)
        expectEqual(s.stateSince, Date(timeIntervalSince1970: 5000))
        expectEqual(s.pinned, true)
        expectEqual(s.position, 2)
        expectEqual(s.icon, SessionIcon(character: "ghost", color: "#4f7cff"))
    }

    test("decodes a snapshot, null fields and all") {
        let json = #"{"type":"snapshot","focusedId":null,"sessions":[\#(sessionJSON),"#
            + ##"{"id":"b","name":"n","cwd":"/","state":"done","activity":null,"live":false,"stateSince":0,"pinned":false,"position":null,"icon":{"character":"default","color":"#d97757"}}]}"##
        guard case .snapshot(let sessions, let focusedId)? = ServerMessage.parse(json) else {
            return expect(false, "not a snapshot")
        }
        expectEqual(sessions.count, 2)
        expectEqual(focusedId, nil)
        expectEqual(sessions[1].activity, nil)
        expectEqual(sessions[1].position, nil)
    }

    test("a snapshot skips sessions it can't read instead of dropping them all") {
        let json = #"{"type":"snapshot","focusedId":"x","sessions":[\#(sessionJSON),{"id":42}]}"#
        guard case .snapshot(let sessions, let focusedId)? = ServerMessage.parse(json) else {
            return expect(false, "not a snapshot")
        }
        expectEqual(sessions.map(\.name), ["Node migration"])
        expectEqual(focusedId, "x")
    }

    test("a state from a newer agent reads as idle") {
        let json = sessionJSON.replacingOccurrences(of: "needs_permission", with: "dreaming")
        guard case .session(let s)? = ServerMessage.parse(#"{"type":"session","session":\#(json)}"#) else {
            return expect(false, "not a session message")
        }
        expectEqual(s.state, .idle)
    }

    test("decodes removed, focus and error") {
        expectEqual(ServerMessage.parse(#"{"type":"removed","id":"a"}"#), .removed(id: "a"))
        expectEqual(ServerMessage.parse(#"{"type":"focus","id":"a"}"#), .focus(id: "a"))
        expectEqual(ServerMessage.parse(#"{"type":"focus","id":null}"#), .focus(id: nil))
        expectEqual(ServerMessage.parse(#"{"type":"error","message":"unknown session"}"#), .error(message: "unknown session"))
    }

    test("ignores messages it doesn't use and anything malformed") {
        expectEqual(ServerMessage.parse(#"{"type":"surprise"}"#), nil)
        expectEqual(ServerMessage.parse(#"{"type":"removed"}"#), nil)
        expectEqual(ServerMessage.parse("not json"), nil)
        expectEqual(ServerMessage.parse("[]"), nil)
    }

    test("decodes the session library, skipping entries it can't read") {
        let json = #"{"type":"library","sessions":[{"id":"a","name":"Old work","cwd":"/src","lastActivityAt":5000,"pinned":true},{"id":42}]}"#
        expectEqual(ServerMessage.parse(json), .library([
            LibraryEntry(id: "a", name: "Old work", cwd: "/src", lastActivityAt: Date(timeIntervalSince1970: 5), pinned: true),
        ]))
    }

    test("encodes open, pin and icon") {
        func object(_ message: ClientMessage) throws -> NSDictionary? {
            try JSONSerialization.jsonObject(with: Data(message.json.utf8)) as? NSDictionary
        }
        expectEqual(try object(.open(id: "abc")), ["type": "open", "id": "abc"])
        expectEqual(try object(.library), ["type": "library"])
        expectEqual(try object(.terminal), ["type": "terminal"])
        expectEqual(try object(.stop(id: "abc")), ["type": "stop", "id": "abc"])
        expectEqual(try object(.pin(id: "abc", pinned: true)), ["type": "pin", "id": "abc", "pinned": true])
        expectEqual(
            try object(.icon(id: "abc", icon: SessionIcon(character: "cat", color: "#4f7cff"))),
            ["type": "icon", "id": "abc", "icon": ["character": "cat", "color": "#4f7cff"]]
        )
    }

    test("client messages name their session, except the library and terminal requests") {
        let icon = SessionIcon.default
        for message in [ClientMessage.open(id: "a"), .pin(id: "a", pinned: false), .icon(id: "a", icon: icon), .stop(id: "a")] {
            expectEqual(message.sessionId, "a")
        }
        expectEqual(ClientMessage.library.sessionId, nil)
        expectEqual(ClientMessage.terminal.sessionId, nil)
    }

    test("decodes the session kind, and a message without one") {
        let bg = sessionJSON.replacingOccurrences(of: #""icon":"#, with: #""kind":"background","icon":"#)
        guard case .session(let a)? = ServerMessage.parse(#"{"type":"session","session":\#(bg)}"#),
              case .session(let b)? = ServerMessage.parse(#"{"type":"session","session":\#(sessionJSON)}"#) else {
            return expect(false, "not a session message")
        }
        expectEqual(a.kind, "background")
        expectEqual(b.kind, nil)
    }

    test("only a live background session can be stopped, and an active one asks first") {
        expectEqual(session(live: true, kind: "background").canStop, true)
        expectEqual(session(live: false, kind: "background").canStop, false)
        expectEqual(session(live: true, kind: "interactive").canStop, false)
        expectEqual(session(live: true, kind: nil).canStop, false)
        for state in [SessionState.working, .compacting, .needsPermission, .needsInput] {
            expectEqual(session(state: state, kind: "background").stopNeedsConfirmation, true)
        }
        for state in [SessionState.idle, .done, .error, .ended] {
            expectEqual(session(state: state, kind: "background").stopNeedsConfirmation, false)
        }
    }

    test("the color palette matches the Pi panel's and includes the default") {
        expectEqual(SessionIcon.palette.map(\.color), ["#ff6b1a", "#d97757", "#ffd23f", "#4cd964", "#3ccfe6", "#4f7cff", "#a66cff", "#ff5fa2", "#e8e8e8"])
        expect(SessionIcon.palette.contains { $0.color == SessionIcon.default.color })
    }

    test("reads the pairing token from the agent's config") {
        expectEqual(AgentConfig.token(fromJSON: Data(#"{"token":"s3cret"}"#.utf8)), "s3cret")
        expectEqual(AgentConfig.token(fromJSON: Data(#"{"token":""}"#.utf8)), nil)
        expectEqual(AgentConfig.token(fromJSON: Data("{}".utf8)), nil)
        expectEqual(AgentConfig.token(fromJSON: Data("garbage".utf8)), nil)
    }

    test("reads the token from Tomari's agent, where agent/src/config.ts writes it") {
        expect(AgentConfig.configFile.path.hasSuffix("/Library/Application Support/tomari/config.json"), AgentConfig.configFile.path)
    }

    test("builds the WebSocket URL with the token escaped") {
        let url = AgentConfig.webSocketURL(token: "a+b/c=")
        expectEqual(url.absoluteString, "ws://127.0.0.1:7778/ws?token=a%2Bb/c%3D")
    }
}
