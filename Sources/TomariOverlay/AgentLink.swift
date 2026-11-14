import AppKit
import Foundation
import Observation
import TomariCore

/// Reconnects forever; while disconnected, the last known sessions stay on screen.
@MainActor @Observable
final class AgentLink {
    enum Status: Equatable {
        case connecting
        case online
        case notPaired
        case offline
    }

    struct Notice: Equatable {
        /// Nil when the notice is about the add button's request for the session library.
        let sessionId: String?
        let message: String
    }

    private(set) var list = SessionList()
    private(set) var status = Status.connecting
    private(set) var notice: Notice?

    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private var retryDelay = AgentLink.minRetry
    @ObservationIgnored private var lastSent: ClientMessage?
    @ObservationIgnored private var libraryReply: (([LibraryEntry]) -> Void)?
    @ObservationIgnored private var noticeExpiry: Task<Void, Never>?
    @ObservationIgnored private var doneChime = DoneChime()
    @ObservationIgnored private var frontReporter = FrontAppReporter()
    @ObservationIgnored private var frontObserver: NSObjectProtocol?

    private static let minRetry: Duration = .seconds(1)
    private static let maxRetry: Duration = .seconds(10)
    /// A socket can die silently while the Mac sleeps; a failed ping notices it.
    private static let pingEvery: Duration = .seconds(20)
    private static let noticeVisible: Duration = .seconds(4)

    func start() {
        // The agent asks Terminal about its tabs only while Terminal is in front, so it needs to be told.
        frontObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated { self?.reportFrontApp(bundleId: app?.bundleIdentifier) }
        }
        connect()
    }

    /// Without an argument it asks the system what is in front, as on connecting.
    private func reportFrontApp(bundleId: String? = NSWorkspace.shared.frontmostApplication?.bundleIdentifier) {
        guard status == .online, let task, let kind = frontReporter.next(FrontAppKind(bundleId: bundleId)) else { return }
        task.send(.string(ClientMessage.frontApp(kind).json)) { _ in }
    }

    func send(_ message: ClientMessage) {
        guard status == .online, let task else {
            return show(Notice(sessionId: message.sessionId, message: "not connected to the agent"))
        }
        lastSent = message
        task.send(.string(message.json)) { _ in }
    }

    /// `reply` runs once, with the desktop sessions that can be pinned, most recent first.
    func requestLibrary(then reply: @escaping ([LibraryEntry]) -> Void) {
        libraryReply = reply
        send(.library)
    }

    private func connect() {
        guard let token = AgentConfig.token() else {
            status = .notPaired
            return retry()
        }
        let task = URLSession.shared.webSocketTask(with: AgentConfig.webSocketURL(token: token))
        task.maximumMessageSize = 4 << 20
        self.task = task
        task.resume()
        Task { await receive(from: task) }
        Task { await keepAlive(task) }
    }

    private func receive(from task: URLSessionWebSocketTask) async {
        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                guard self.task === task else { return }
                self.task = nil
                frontReporter.reset()
                status = .offline
                return retry()
            }
            guard case .string(let text) = message, let parsed = ServerMessage.parse(text) else { continue }
            // The agent answers a bad token by refusing the upgrade, so any message means we're in.
            let wasOnline = status == .online
            status = .online
            if !wasOnline { reportFrontApp() }
            retryDelay = Self.minRetry
            switch parsed {
            case .error(let text):
                // The agent's errors don't name a session; they answer the last message sent.
                if let lastSent { show(Notice(sessionId: lastSent.sessionId, message: text)) }
            case .library(let entries):
                libraryReply?(entries)
                libraryReply = nil
            default:
                chimeIfFinished(parsed)
                list.apply(parsed)
            }
        }
    }

    /// Called before `parsed` is applied, so the list still holds the session as it was.
    private func chimeIfFinished(_ parsed: ServerMessage) {
        guard Preferences.soundWhenDone, case .session(let session) = parsed else { return }
        let terminalFront = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Terminal"
        if doneChime.shouldChime(for: parsed, previous: list.sessions[session.id], focusedId: list.focusedId, terminalFrontmost: terminalFront, at: Date()) {
            NSSound(named: "Glass")?.play()
        }
    }

    private func keepAlive(_ task: URLSessionWebSocketTask) async {
        while self.task === task {
            try? await Task.sleep(for: Self.pingEvery)
            guard self.task === task else { return }
            task.sendPing { error in
                if error != nil { task.cancel(with: .goingAway, reason: nil) } // receive() then fails and reconnects
            }
        }
    }

    private func retry() {
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, Self.maxRetry)
        Task {
            try? await Task.sleep(for: delay)
            connect()
        }
    }

    private func show(_ notice: Notice) {
        self.notice = notice
        noticeExpiry?.cancel()
        noticeExpiry = Task {
            try? await Task.sleep(for: Self.noticeVisible)
            if !Task.isCancelled { self.notice = nil }
        }
    }
}
