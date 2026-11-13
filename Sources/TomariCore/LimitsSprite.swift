import Foundation

private let dim = RGB(hex: "#8b909a")!
private let calm = RGB(r: 217, g: 217, b: 217)

/// 3x5 glyphs for the window labels: 5 hours, 7 days.
private let glyphs: [Character: [String]] = [
    "5": ["XXX", "X..", "XXX", "..X", "XXX"],
    "7": ["XXX", "..X", ".X.", ".X.", ".X."],
]

extension CreatureAppearance {
    /// The strip cell that shows the account's limits: a small bar per window, 5 hours above 7 days.
    /// A hot window rings the tile in red.
    public static func limits(_ meters: [LimitMeter], hovered: Bool) -> CreatureAppearance {
        let barX = 5, barWidth = 18, barHeight = 5, gap = 4
        let shown = Array(meters.prefix(2))
        let total = shown.count * barHeight + max(shown.count - 1, 0) * gap
        var pixels = Pixels(repeating: Array(repeating: nil, count: spriteSize), count: spriteSize)

        for (row, meter) in shown.enumerated() {
            let top = (spriteSize - total) / 2 + row * (barHeight + gap)
            if let glyph = meter.label.first.flatMap({ glyphs[$0] }) {
                for (y, line) in glyph.enumerated() {
                    for (x, cell) in line.enumerated() where cell == "X" { pixels[top + y][1 + x] = dim }
                }
            }
            for x in barX..<(barX + barWidth) {
                for y in 0..<barHeight {
                    let edge = x == barX || x == barX + barWidth - 1 || y == 0 || y == barHeight - 1
                    if edge { pixels[top + y][x] = dim }
                }
            }
            let room = barWidth - 2
            var filled = Int((meter.fraction * Double(room)).rounded())
            if meter.fraction > 0 { filled = max(filled, 1) }
            let color: RGB
            switch meter.level {
            case .ok: color = calm
            case .warm: color = Paint.accent.rgb
            case .hot: color = Paint.danger.rgb
            }
            for x in 0..<min(filled, room) {
                for y in 1..<(barHeight - 1) { pixels[top + y][barX + 1 + x] = color }
            }
        }

        var tile = hovered ? Tile(fill: .white(0.12)) : Tile()
        if shown.contains(where: { $0.level == .hot }) { tile.border = .danger }
        return CreatureAppearance(pixels: pixels, tile: tile, opacity: 1)
    }
}
