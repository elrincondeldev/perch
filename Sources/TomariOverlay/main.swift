import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var link: AgentLink?
    private var strip: StripController?
    private var menuBar: MenuBar?
    private var jumpKey: JumpHotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let link = AgentLink()
        let strip = StripController(link: link)
        let jumpKey = JumpHotKey(link: link)
        if Preferences.jumpToWaiting { jumpKey.register() }
        menuBar = MenuBar(link: link, strip: strip, jumpKey: jumpKey)
        self.jumpKey = jumpKey
        self.link = link
        self.strip = strip
        link.start()
    }
}

guard SingleInstance.claim() else {
    FileHandle.standardError.write(Data("tomari-overlay is already running\n".utf8))
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    // An accessory executable, not a .app: an app would need a Homebrew cask, which quarantines it.
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
