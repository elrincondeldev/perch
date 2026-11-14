import Foundation
import TomariCore

func frontAppTests() {
    test("Terminal, the Claude desktop app and everything else map to their kinds") {
        expectEqual(FrontAppKind(bundleId: "com.apple.Terminal"), .terminal)
        expectEqual(FrontAppKind(bundleId: "com.anthropic.claudefordesktop"), .desktop)
        expectEqual(FrontAppKind(bundleId: "com.apple.Safari"), .other)
        expectEqual(FrontAppKind(bundleId: "com.apple.Terminal.helper"), .other)
        expectEqual(FrontAppKind(bundleId: nil), .other)
    }

    test("the reporter sends the first kind and then only changes") {
        var reporter = FrontAppReporter()
        expectEqual(reporter.next(.other), .other)
        expectEqual(reporter.next(.other), nil)
        expectEqual(reporter.next(.terminal), .terminal)
        expectEqual(reporter.next(.terminal), nil)
        expectEqual(reporter.next(.other), .other)
    }

    test("after a reconnect the reporter sends the current kind again") {
        var reporter = FrontAppReporter()
        _ = reporter.next(.terminal)
        reporter.reset()
        expectEqual(reporter.next(.terminal), .terminal)
    }

    test("frontApp encodes its kind and names no session") {
        expectEqual(ClientMessage.frontApp(.terminal).json, #"{"app":"terminal","type":"frontApp"}"#)
        expectEqual(ClientMessage.frontApp(.desktop).json, #"{"app":"desktop","type":"frontApp"}"#)
        expectEqual(ClientMessage.frontApp(.other).json, #"{"app":"other","type":"frontApp"}"#)
        expectEqual(ClientMessage.frontApp(.other).sessionId, nil)
    }
}
