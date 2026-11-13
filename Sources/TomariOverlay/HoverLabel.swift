import AppKit
import TomariCore

@MainActor
final class HoverLabel {
    struct Content: Equatable {
        var name: String
        var status: String
        var statusColor: NSColor
        var frameBeside: CGRect
        /// The label stays clear of this.
        var outside: CGRect
        var edge: ScreenEdge
        /// An optional third line, e.g. a session's context and cost.
        var detail: String?
    }

    private let panel = OverlayPanel()
    private let name = NSTextField(labelWithString: "")
    private let status = NSTextField(labelWithString: "")
    private let usage = NSTextField(labelWithString: "")
    private var shown: Content?
    private static let maxTextWidth: CGFloat = 300
    private static let padding = NSSize(width: 10, height: 6)
    private static let lineGap: CGFloat = 2

    init() {
        let box = NSView()
        box.wantsLayer = true
        box.layer!.backgroundColor = Style.backdrop
        box.layer!.borderColor = Style.line
        box.layer!.borderWidth = 1
        box.layer!.cornerRadius = 8
        name.font = .systemFont(ofSize: 12, weight: .semibold)
        name.textColor = Style.text
        status.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        usage.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        usage.textColor = Style.muted
        for field in [name, status, usage] {
            field.lineBreakMode = .byTruncatingTail
            field.maximumNumberOfLines = 1
            box.addSubview(field)
        }
        panel.contentView = box
        panel.ignoresMouseEvents = true
    }

    func show(_ content: Content) {
        guard content != shown else { return }
        shown = content
        name.stringValue = content.name
        status.stringValue = content.status
        status.textColor = content.statusColor
        let detail = content.detail ?? ""
        usage.stringValue = detail
        usage.isHidden = detail.isEmpty
        let alignment: NSTextAlignment = content.edge == .right ? .right : .left
        name.alignment = alignment
        status.alignment = alignment
        usage.alignment = alignment

        let nameSize = name.fittingSize
        let statusSize = status.fittingSize
        let usageSize = detail.isEmpty ? .zero : usage.fittingSize
        let width = min(ceil(max(nameSize.width, statusSize.width, usageSize.width)), Self.maxTextWidth)
        let pad = Self.padding
        var bottom = pad.height
        if !detail.isEmpty {
            usage.frame = NSRect(x: pad.width, y: bottom, width: width, height: usageSize.height)
            bottom = usage.frame.maxY + Self.lineGap
        }
        status.frame = NSRect(x: pad.width, y: bottom, width: width, height: statusSize.height)
        name.frame = NSRect(x: pad.width, y: status.frame.maxY + Self.lineGap, width: width, height: nameSize.height)
        let size = CGSize(width: width + 2 * pad.width, height: name.frame.maxY + pad.height)

        panel.setFrame(StripLayout.labelFrame(size: size, beside: content.frameBeside, outside: content.outside, edge: content.edge), display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        shown = nil
        panel.orderOut(nil)
    }
}
