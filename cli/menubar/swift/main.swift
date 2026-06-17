// Cells menubar — native macOS status item.
//
// Polls ~/.cells/cells.json and `well list` every 10s
// and renders a dropdown of cells. Click actions open Ghostty (shell, tui) or
// the browser (site). Auto-launched by a LaunchAgent installed by
// `cells menubar install`.

import AppKit
import Foundation

// MARK: - Config

let REFRESH_SECONDS: TimeInterval = 10
let WELL_BASE = "cells.md"
let CELLS_BIN_ENV = "CELLS_BIN"

// Resolved at startup. The LaunchAgent plist pre-sets CELLS_BIN to the
// absolute path of the user's `cells` entrypoint; we fall back to a sensible
// default if unset (e.g. when running the app by hand).
let cellsBin: String = {
    if let env = ProcessInfo.processInfo.environment[CELLS_BIN_ENV], !env.isEmpty {
        return env
    }
    return NSHomeDirectory() + "/.local/bin/cells"
}()

// MARK: - Models

struct Cell: Decodable {
    let name: String
    let hatched_from: String?
    let special: Bool?
    let harness: String?
}

struct CellsFile: Decodable {
    let cells: [Cell]
}

enum WellStatus: String {
    case running
    case stopped
    case unknown
}

struct EnrichedCell {
    let cell: Cell
    let well: String
    let status: WellStatus
    let postBirth: String  // "done", "running", or ""
}

// MARK: - Loaders

func cellsJSONPath() -> String { NSHomeDirectory() + "/.cells/cells.json" }

func loadCells() -> [Cell] {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: cellsJSONPath())) else { return [] }
    return (try? JSONDecoder().decode(CellsFile.self, from: data).cells) ?? []
}

// A hatched cell lives in well `egg-<hatched_from>` (the pool.json indirection
// was removed 2026-06-17 with the egg pool; mirrors cli/lib/resolve.ts).
func wellNameFor(_ cell: Cell) -> String {
    if cell.special == true { return "cells-\(cell.name)" }
    guard let h = cell.hatched_from else { return cell.name }
    return "egg-\(h)"
}

// Post-birth log lives at ~/.cells/logs/birth-postwork/<name>.log. We surface
// a ⏳ chip while running; nothing once "post-birth done" is seen or the log
// is absent.
func postBirthStatus(_ name: String) -> String {
    let path = NSHomeDirectory() + "/.cells/logs/birth-postwork/\(name).log"
    guard FileManager.default.fileExists(atPath: path) else { return "" }
    guard let txt = try? String(contentsOfFile: path, encoding: .utf8) else { return "" }
    return txt.contains("post-birth done") ? "done" : "running"
}

// Resolve the absolute path of the `well` binary. LaunchAgents run with a
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) so a bare "well" lookup fails
// even though it works in any interactive shell. Probe the usual install
// locations.
func resolveWellPath() -> String? {
    let home = NSHomeDirectory()
    let candidates = [
        "\(home)/.local/bin/well",
        "/opt/homebrew/bin/well",
        "/usr/local/bin/well",
    ]
    for p in candidates where FileManager.default.isExecutableFile(atPath: p) {
        return p
    }
    return nil
}

// Shell out to `well list` (synchronously). Parses lines like:
//   "egg-833480    running  192.168.64.205  23h"
func loadWellStatuses() -> [String: WellStatus] {
    var map: [String: WellStatus] = [:]
    guard let wellBin = resolveWellPath() else { return map }
    let task = Process()
    task.launchPath = wellBin
    task.arguments = ["list"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try task.run()
    } catch {
        return map
    }
    task.waitUntilExit()
    guard let data = try? pipe.fileHandleForReading.readToEnd(),
          let out = String(data: data, encoding: .utf8) else { return map }
    let lines = out.split(separator: "\n").dropFirst() // header row
    for line in lines {
        // Columns are whitespace-aligned (multiple spaces); split on any
        // run of whitespace so trailing-column padding doesn't trip us up.
        let parts = line.split(whereSeparator: { $0.isWhitespace })
        guard parts.count >= 2 else { continue }
        let name = String(parts[0])
        let st: WellStatus
        switch parts[1] {
        case "running": st = .running
        case "stopped": st = .stopped
        default: st = .unknown
        }
        map[name] = st
    }
    return map
}

// MARK: - Snapshot

func snapshot() -> [EnrichedCell] {
    let cells = loadCells()
    let statuses = loadWellStatuses()
    let enriched = cells.map { c -> EnrichedCell in
        let well = wellNameFor(c)
        let status = statuses[well] ?? .unknown
        return EnrichedCell(cell: c, well: well, status: status, postBirth: postBirthStatus(c.name))
    }
    return enriched.sorted { a, b in
        let aAlive = a.status == .running ? 0 : 1
        let bAlive = b.status == .running ? 0 : 1
        if aAlive != bAlive { return aAlive < bAlive }
        return a.cell.name < b.cell.name
    }
}

// MARK: - Actions

// Open Ghostty and run `cells <args>` with a hold-open trailer so failures
// stay readable. We use the user's login shell (and pre-pend ~/.bun/bin +
// ~/.local/bin to PATH) because the `cells` script is a TS file with a
// `#!/usr/bin/env bun` shebang — without bun on PATH, exec fails with
// "env: bun: No such file or directory".
func openInGhostty(args: [String]) {
    let quoted = ([cellsBin] + args).map { shellQuote($0) }.joined(separator: " ")
    let home = NSHomeDirectory()
    let pathPrefix = "\(home)/.bun/bin:\(home)/.local/bin:/opt/homebrew/bin"
    let inner = """
    export PATH=\"\(pathPrefix):$PATH\"; \(quoted); status=$?; echo; if [ $status -ne 0 ]; then echo \"(exited $status)\"; fi; read -n 1 -s -r -p \"[any key to close]\"; echo
    """
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let task = Process()
    task.launchPath = "/usr/bin/open"
    task.arguments = ["-na", "Ghostty.app", "--args", "-e", shell, "-lc", inner]
    try? task.run()
}

func shellQuote(_ s: String) -> String {
    if s.range(of: "[^A-Za-z0-9_./:=@%+-]", options: .regularExpression) == nil { return s }
    return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

func openURL(_ url: String) {
    guard let u = URL(string: url) else { return }
    NSWorkspace.shared.open(u)
}

// MARK: - Menu construction

final class CellAction: NSObject {
    let handler: () -> Void
    init(_ h: @escaping () -> Void) { handler = h }
    @objc func fire() { handler() }
}

// Strong references for closure-bearing targets — NSMenuItem.target is weak.
var actionHolder: [CellAction] = []

func menuItem(_ title: String, action: (() -> Void)? = nil, key: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: key)
    if let a = action {
        let h = CellAction(a)
        actionHolder.append(h)
        item.target = h
        item.action = #selector(CellAction.fire)
    }
    return item
}

func buildSubmenu(for entry: EnrichedCell) -> NSMenu {
    let m = NSMenu()
    let name = entry.cell.name

    // Detail header — disabled, secondary color, small font. Lives at the top
    // of the submenu so the main list stays tight.
    let harness = entry.cell.harness ?? "pi"
    let deployTrailer = entry.postBirth.isEmpty ? "" : " · deploy \(entry.postBirth)"
    let detail = NSMenuItem(
        title: "\(harness) · well \(entry.well) · \(entry.status.rawValue)\(deployTrailer)",
        action: nil,
        keyEquivalent: ""
    )
    detail.isEnabled = false
    detail.attributedTitle = NSAttributedString(
        string: detail.title,
        attributes: [
            .font: NSFont.menuFont(ofSize: 11),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
    )
    m.addItem(detail)
    m.addItem(.separator())

    m.addItem(menuItem("Open shell") { openInGhostty(args: ["shell", name]) })
    m.addItem(menuItem("Open TUI in Ghostty") { openInGhostty(args: ["tui", name]) })
    m.addItem(menuItem("Open site") { openURL("https://\(name).\(WELL_BASE)") })
    return m
}

func rebuildMenu(_ menu: NSMenu, statusButton: NSStatusBarButton) {
    menu.removeAllItems()
    actionHolder.removeAll(keepingCapacity: true)

    let entries = snapshot()
    let aliveCount = entries.filter { $0.status == .running }.count
    // Monochrome icon + count. SF Symbol marked as a template image so AppKit
    // auto-tints it white/black to match the menubar appearance — no manual
    // dark/light handling needed.
    if let img = NSImage(systemSymbolName: "circle.hexagongrid.fill",
                         accessibilityDescription: "cells") {
        img.isTemplate = true
        statusButton.image = img
        statusButton.imagePosition = .imageLeading
    }
    statusButton.title = " \(aliveCount)"

    if entries.isEmpty {
        let empty = NSMenuItem(title: "no cells", action: nil, keyEquivalent: "")
        empty.isEnabled = false
        menu.addItem(empty)
    } else {
        for e in entries {
            let item = NSMenuItem(title: e.cell.name, action: nil, keyEquivalent: "")
            // Compose the row: cell name in the default menu font, then a
            // small green " running" suffix when the well is up. Hibernated
            // / stopped / unknown cells get nothing — just the name.
            let title = NSMutableAttributedString(
                string: e.cell.name,
                attributes: [.font: NSFont.menuFont(ofSize: 0)]  // 0 = system default
            )
            if e.status == .running {
                title.append(NSAttributedString(
                    string: "  running",
                    attributes: [
                        .font: NSFont.menuFont(ofSize: 10),
                        .foregroundColor: NSColor.systemGreen,
                    ]
                ))
            }
            if e.postBirth == "running" {
                title.append(NSAttributedString(
                    string: "  ⏳",
                    attributes: [.font: NSFont.menuFont(ofSize: 10)]
                ))
            }
            item.attributedTitle = title
            item.submenu = buildSubmenu(for: e)
            menu.addItem(item)
        }
    }

    // Just cells. The only footer is a Quit so the app can be stopped
    // without killing it from the command line.
    menu.addItem(.separator())
    menu.addItem(menuItem("Quit", action: { NSApp.terminate(nil) }, key: "q"))
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        statusItem.menu = menu
        refresh()
        // Tick on the main run loop so menu updates happen on the main thread.
        timer = Timer.scheduledTimer(withTimeInterval: REFRESH_SECONDS, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func refresh() {
        guard let menu = statusItem.menu, let button = statusItem.button else { return }
        rebuildMenu(menu, statusButton: button)
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // background-only, no Dock icon
app.run()
