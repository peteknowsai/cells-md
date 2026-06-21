// Cells menubar — native macOS status item.
//
// Polls ~/.cells/cells.json and `well list` every 10s
// and renders a dropdown of cells. Click actions open Ghostty (shell, tui) or
// the browser (site). A "Projects" submenu filters the list to selected
// projects (multi-select, persisted to ~/.cells/menubar/filter.json). Auto-
// launched by a LaunchAgent installed by `cells menubar install`.

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
    let well: String?            // stored well name (cells-<name>; legacy cells keep their real name)
    let hatched_from: String?    // legacy marker, no longer used for resolution
    let special: Bool?
    let harness: String?
    let project: String?         // fleet-grouping label (see `cells project`); "" / nil = unassigned
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

// Cell → well-name. Mirrors cli/lib/resolve.ts: read the stored `well`, else
// default to the `cells-<name>` namespace convention (specials + new cells).
// Legacy cells were backfilled with their real well name, so no derivation here.
func wellNameFor(_ cell: Cell) -> String {
    return cell.well ?? "cells-\(cell.name)"
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

// MARK: - Project filter
//
// Which projects to show. Persisted to ~/.cells/menubar/filter.json as
// {"projects": ["zero","kdice"]} so a toggle survives restarts. Empty (or
// missing) = show everything. The global operators (mother/pulse — special,
// no project) stay pinned regardless of the filter; project-scoped cells
// (including zero-mother/zero-pulse) obey it. See rebuildMenu for the rule.

func filterPath() -> String { NSHomeDirectory() + "/.cells/menubar/filter.json" }

struct FilterFile: Codable { var projects: [String] }

func loadFilter() -> Set<String> {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: filterPath())),
          let f = try? JSONDecoder().decode(FilterFile.self, from: data) else { return [] }
    return Set(f.projects.filter { !$0.isEmpty })
}

func saveFilter(_ set: Set<String>) {
    let dir = NSHomeDirectory() + "/.cells/menubar"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let f = FilterFile(projects: set.sorted())
    guard let data = try? JSONEncoder().encode(f) else { return }
    try? data.write(to: URL(fileURLWithPath: filterPath()))
}

func toggleProject(_ p: String) {
    var set = loadFilter()
    if set.contains(p) { set.remove(p) } else { set.insert(p) }
    saveFilter(set)
}

// A cell's project label, normalized: trimmed, "" for unassigned.
func projectOf(_ cell: Cell) -> String {
    return (cell.project ?? "").trimmingCharacters(in: .whitespaces)
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

// Set by the app delegate so a filter toggle can force an immediate rebuild
// instead of waiting for the next 10s timer tick.
var requestRefresh: () -> Void = {}

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

// The "Projects" submenu: "Show all" plus a checkmark per known project.
// Multi-select — checking zero AND kdice shows both. Toggling persists to
// filter.json and forces an immediate rebuild.
func buildProjectsSubmenu(allProjects: [String], filter: Set<String>) -> NSMenu {
    let m = NSMenu()

    let all = menuItem("Show all") { saveFilter([]); requestRefresh() }
    all.state = filter.isEmpty ? .on : .off
    m.addItem(all)

    if !allProjects.isEmpty {
        m.addItem(.separator())
        for p in allProjects {
            let item = menuItem(p) { toggleProject(p); requestRefresh() }
            item.state = filter.contains(p) ? .on : .off
            m.addItem(item)
        }
    }
    return m
}

func rebuildMenu(_ menu: NSMenu, statusButton: NSStatusBarButton) {
    menu.removeAllItems()
    actionHolder.removeAll(keepingCapacity: true)

    let entries = snapshot()
    let filter = loadFilter()

    // Every project that has at least one (non-operator) cell, unioned with any
    // currently-selected projects so a stale selection can still be unchecked.
    var projSet = Set<String>()
    for e in entries where !(e.cell.special ?? false) {
        let p = projectOf(e.cell)
        if !p.isEmpty { projSet.insert(p) }
    }
    projSet.formUnion(filter)
    let allProjects = projSet.sorted()

    // Global operators (special, no project — i.e. mother/pulse) are the
    // fleet's core and always show. Project-scoped operators (zero-mother,
    // zero-pulse) and regular cells obey the filter, so "only kdice" really
    // means kdice. An empty filter shows everything.
    let visible = entries.filter { e in
        let p = projectOf(e.cell)
        if e.cell.special == true && p.isEmpty { return true }
        if filter.isEmpty { return true }
        return filter.contains(p)
    }
    let aliveCount = visible.filter { $0.status == .running }.count

    // Monochrome icon + count. SF Symbol marked as a template image so AppKit
    // auto-tints it white/black to match the menubar appearance — no manual
    // dark/light handling needed. A filter funnel replaces the grid when a
    // project filter is hiding cells.
    let iconName = filter.isEmpty ? "circle.hexagongrid.fill"
                                  : "line.3.horizontal.decrease.circle.fill"
    if let img = NSImage(systemSymbolName: iconName, accessibilityDescription: "cells") {
        img.isTemplate = true
        statusButton.image = img
        statusButton.imagePosition = .imageLeading
    }
    statusButton.title = " \(aliveCount)"

    // Project filter control — only shown once there's at least one project to
    // filter by (or a filter is active). Lives at the top, doubling as a
    // status line for the current filter.
    if !allProjects.isEmpty || !filter.isEmpty {
        let label = filter.isEmpty
            ? "Projects: all"
            : "Projects: \(filter.sorted().joined(separator: ", "))"
        let projItem = NSMenuItem(title: label, action: nil, keyEquivalent: "")
        projItem.submenu = buildProjectsSubmenu(allProjects: allProjects, filter: filter)
        menu.addItem(projItem)
        menu.addItem(.separator())
    }

    if visible.isEmpty {
        let msg = filter.isEmpty ? "no cells" : "no cells in filter"
        let empty = NSMenuItem(title: msg, action: nil, keyEquivalent: "")
        empty.isEnabled = false
        menu.addItem(empty)
    } else {
        for e in visible {
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
        // Let filter toggles force an immediate rebuild rather than waiting for
        // the next timer tick.
        requestRefresh = { [weak self] in self?.refresh() }
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
