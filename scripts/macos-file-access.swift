import AppKit
import Foundation
import Darwin
import Security

// Only this sandboxed app resolves its private bookmarks. Node and the cloud
// receive capability results, never bookmarks, selected paths or file contents.
let bundleID = "com.xiaoman.file-access"
let maxSelections = 32
let maxStoreBytes = 1_048_576

struct BookmarkStore: Codable {
    var version = 1
    var bookmarks: [Data]
    // Optional so the deployed version-1 custom bookmarks decode unchanged.
    var defaultsConfirmed: Bool? = nil
}

enum AccessError: Error { case store, limit }

func result(_ state: String, _ code: String, count: Int = 0, accessible: Int = 0) -> [String: Any] {
    let readable = count > 0 && accessible == count
    return ["version": 1, "state": state, "code": code,
            "selectedCount": count, "accessibleCount": accessible,
            "permissions": [
                ["id": "readable", "granted": readable, "verified": count > 0],
                // Selecting resources and Full Disk Access are distinct OS grants.
                ["id": "full_disk", "granted": false, "verified": false]
            ]]
}

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

func storeDirectory() throws -> URL {
    let support = try FileManager.default.url(for: .applicationSupportDirectory,
        in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = support.appendingPathComponent(bundleID, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    return directory
}

func lockedStore<T>(_ body: (URL) throws -> T) throws -> T {
    let directory = try storeDirectory()
    let lock = directory.appendingPathComponent("bookmarks.lock")
    let fd = Darwin.open(lock.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw AccessError.store }
    defer { Darwin.close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw AccessError.store }
    defer { flock(fd, LOCK_UN) }
    return try body(directory.appendingPathComponent("bookmarks.json"))
}

func readStore(_ url: URL) throws -> BookmarkStore {
    let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    if fd < 0 && errno == ENOENT { return BookmarkStore(bookmarks: []) }
    guard fd >= 0 else { throw AccessError.store }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(),
          info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0,
          info.st_size >= 0, info.st_size <= maxStoreBytes else { throw AccessError.store }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    guard let data = try handle.readToEnd(), data.count <= maxStoreBytes else { throw AccessError.store }
    let store = try JSONDecoder().decode(BookmarkStore.self, from: data)
    guard store.version == 1, store.bookmarks.count <= maxSelections else { throw AccessError.store }
    return store
}

func writeStore(_ store: BookmarkStore, to url: URL) throws {
    let data = try JSONEncoder().encode(store)
    guard data.count <= maxStoreBytes else { throw AccessError.limit }
    let temporary = url.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".tmp")
    defer { try? FileManager.default.removeItem(at: temporary) }
    let fd = Darwin.open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw AccessError.store }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try handle.close()
    guard Darwin.rename(temporary.path, url.path) == 0 else { throw AccessError.store }
}

func readable(_ url: URL) -> Bool {
    var info = stat()
    guard url.path.withCString({ fstatat(AT_FDCWD, $0, &info, 0) }) == 0 else { return false }
    if info.st_mode & S_IFMT == S_IFDIR {
        // Opening the directory verifies access without enumerating names.
        guard let directory = opendir(url.path) else { return false }
        closedir(directory)
        return true
    }
    guard info.st_mode & S_IFMT == S_IFREG else { return false }
    let fd = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return false }
    defer { Darwin.close(fd) }
    var byte: UInt8 = 0
    return Darwin.read(fd, &byte, 1) >= 0
}

func probe() -> [String: Any] {
    do {
        return try lockedStore { path in
            var store = try readStore(path)
            if store.bookmarks.isEmpty { return result("awaiting_authorization", "not_authenticated") }
            var accessible = 0
            var changed = false
            for index in store.bookmarks.indices {
                var stale = false
                guard let url = try? URL(resolvingBookmarkData: store.bookmarks[index],
                    options: [.withSecurityScope, .withoutUI, .withoutMounting],
                    relativeTo: nil, bookmarkDataIsStale: &stale) else { continue }
                guard url.startAccessingSecurityScopedResource() else { continue }
                defer { url.stopAccessingSecurityScopedResource() }
                if readable(url) {
                    accessible += 1
                    if stale, let data = try? url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                        includingResourceValuesForKeys: nil, relativeTo: nil) {
                        store.bookmarks[index] = data
                        changed = true
                    }
                }
            }
            if changed { try writeStore(store, to: path) }
            let complete = accessible == store.bookmarks.count
            return result(complete ? "connected" : "limited", complete ? "ok" : "permission_required",
                count: store.bookmarks.count, accessible: accessible)
        }
    } catch { return result("error", "probe_failed") }
}

func actualUserHome() -> URL? {
    // NSHomeDirectory/FileManager.homeDirectoryForCurrentUser are redirected to
    // the sandbox container. Account metadata identifies the actual OS home.
    guard let record = getpwuid(getuid()), let directory = record.pointee.pw_dir else { return nil }
    let path = String(cString: directory)
    guard path.hasPrefix("/"), path != "/", !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
}

func sameDirectory(_ first: URL, _ second: URL) -> Bool {
    first.standardizedFileURL.path == second.standardizedFileURL.path
}

func probeDefaults(requiresConfirmation: Bool = true) -> [String: Any] {
    guard let home = actualUserHome() else { return result("error", "probe_failed") }
    do {
        return try lockedStore { path in
            let store = try readStore(path)
            if requiresConfirmation && store.defaultsConfirmed != true {
                return result("awaiting_authorization", "not_authenticated")
            }
            for data in store.bookmarks {
                var stale = false
                guard let url = try? URL(resolvingBookmarkData: data,
                    options: [.withSecurityScope, .withoutUI, .withoutMounting], relativeTo: nil,
                    bookmarkDataIsStale: &stale), sameDirectory(url, home),
                    url.startAccessingSecurityScopedResource() else { continue }
                defer { url.stopAccessingSecurityScopedResource() }
                let directories = [url, url.appendingPathComponent("Downloads", isDirectory: true),
                    url.appendingPathComponent("Documents", isDirectory: true)]
                let accessible = directories.filter { readable($0) }.count
                return result(accessible == 3 ? "connected" : "limited",
                    accessible == 3 ? "ok" : "permission_required", count: 3, accessible: accessible)
            }
            // Arbitrary selected files do not imply authorization for default folders.
            return result("awaiting_authorization", "not_authenticated")
        }
    } catch { return result("error", "probe_failed") }
}

final class Authorization: NSObject, NSApplicationDelegate, NSOpenSavePanelDelegate {
    private let defaults: Bool
    private let home: URL?
    private var panel: NSOpenPanel?
    private var alert: NSAlert?
    private var timer: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    private var finished = false

    init(defaults: Bool) {
        self.defaults = defaults
        self.home = defaults ? actualUserHome() : nil
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installCancellation()
        if defaults {
            guard home != nil else { finish(result("error", "probe_failed")); return }
            let existing = probeDefaults(requiresConfirmation: false)
            guard existing["code"] as? String != "probe_failed" else { finish(existing); return }
            if existing["state"] as? String == "connected" {
                confirmExistingDefaults()
                return
            }
        }
        presentPanel()
    }

    private func confirmExistingDefaults() {
        let alert = NSAlert()
        self.alert = alert
        alert.messageText = "允许小满访问默认文件范围？"
        alert.informativeText = "下载、用户目录、文档。\n\n这些目录已获 macOS 读取授权；确认后小满将启用这个默认只读范围，无需重新选择目录。不包含完全磁盘访问权限。"
        alert.addButton(withTitle: "确认允许访问")
        alert.addButton(withTitle: "取消")
        NSApplication.shared.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        guard !finished else { return }
        guard response == .alertFirstButtonReturn else {
            finish(result("awaiting_authorization", "auth_denied"))
            return
        }
        do {
            try lockedStore { path in
                var store = try readStore(path)
                store.defaultsConfirmed = true
                try writeStore(store, to: path)
            }
            finish(probeDefaults())
        } catch { finish(result("error", "authorization_failed")) }
    }

    private func presentPanel() {
        let panel = NSOpenPanel()
        self.panel = panel
        panel.title = defaults ? "允许小满访问默认文件范围" : "允许小满读取文件"
        panel.message = defaults
            ? "默认只读范围：下载、用户目录、文档。已为你定位到用户目录，直接点击“确认允许访问”即可，不需要逐个选择。不授予完全磁盘访问权限。"
            : "选择允许小满只读访问的文件或文件夹。可以选择主目录以覆盖常用文件；这不会授予完全磁盘访问权限。"
        panel.prompt = defaults ? "确认允许访问" : "允许读取"
        panel.canChooseFiles = !defaults
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = !defaults
        panel.canCreateDirectories = false
        panel.resolvesAliases = true
        if defaults {
            panel.directoryURL = home
            panel.delegate = self
        }
        panel.begin { response in
            guard !self.finished else { return }
            guard response == .OK else {
                self.finish(result("awaiting_authorization", "auth_denied"))
                return
            }
            guard !panel.urls.isEmpty, panel.urls.count <= maxSelections else {
                self.finish(result("error", "selection_limit"))
                return
            }
            if self.defaults {
                guard panel.urls.count == 1, let home = self.home,
                      sameDirectory(panel.urls[0], home) else {
                    self.finish(result("awaiting_authorization", "permission_required"))
                    return
                }
            }
            do {
                let bookmarks = try panel.urls.map { url in
                    try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                        includingResourceValuesForKeys: nil, relativeTo: nil)
                }
                try lockedStore { path in
                    if self.defaults {
                        var existing = try readStore(path)
                        guard existing.bookmarks.count < maxSelections else { throw AccessError.limit }
                        existing.bookmarks.append(contentsOf: bookmarks)
                        existing.defaultsConfirmed = true
                        try writeStore(existing, to: path)
                    } else { try writeStore(BookmarkStore(bookmarks: bookmarks), to: path) }
                }
                self.finish(self.defaults ? probeDefaults() : probe())
            } catch { self.finish(result("error", "authorization_failed")) }
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func panel(_ sender: Any, validate url: URL) throws {
        if defaults, let home = home, !sameDirectory(url, home) {
            throw NSError(domain: bundleID, code: 1, userInfo: [NSLocalizedDescriptionKey:
                "默认范围需要允许用户目录，以覆盖下载和文档。请返回预设的用户目录后点击“确认允许访问”。"])
        }
    }

    private func installCancellation() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 175)
        timer.setEventHandler { self.finish(result("awaiting_authorization", "auth_expired")) }
        timer.resume()
        self.timer = timer
        for number in [SIGTERM, SIGINT] {
            Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { self.finish(result("awaiting_authorization", "auth_denied")) }
            source.resume()
            signals.append(source)
        }
    }

    private func finish(_ value: [String: Any]) {
        guard !finished else { return }
        finished = true
        timer?.cancel()
        signals.forEach { $0.cancel() }
        panel?.cancel(nil)
        if alert != nil { NSApplication.shared.abortModal() }
        emit(value)
        // Exiting also releases scoped extensions; the parent may SIGKILL if I/O stalls.
        Darwin.exit(0)
    }
}

func hasEntitlement(_ name: String) -> Bool {
    guard let task = SecTaskCreateFromSelf(nil),
          let value = SecTaskCopyValueForEntitlement(task, name as CFString, nil) else { return false }
    return (value as? Bool) == true
}

guard Bundle.main.bundleIdentifier == bundleID,
      hasEntitlement("com.apple.security.app-sandbox"),
      hasEntitlement("com.apple.security.files.user-selected.read-only"),
      hasEntitlement("com.apple.security.files.bookmarks.app-scope"),
      !hasEntitlement("com.apple.security.files.user-selected.read-write") else {
    emit(result("error", "invalid_installation"))
    Darwin.exit(1)
}
guard CommandLine.arguments.count <= 2 else {
    emit(result("error", "invalid_command"))
    Darwin.exit(1)
}
let command = CommandLine.arguments.count == 1 ? "authorize-defaults" : CommandLine.arguments[1]
switch command {
case "authorize", "authorize-defaults":
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = Authorization(defaults: command == "authorize-defaults")
    app.delegate = delegate
    app.run()
    withExtendedLifetime(delegate) {}
case "probe": emit(probe())
case "probe-defaults": emit(probeDefaults())
case "revoke":
    do {
        try lockedStore { path in try writeStore(BookmarkStore(bookmarks: []), to: path) }
        emit(result("awaiting_authorization", "not_authenticated"))
    } catch { emit(result("error", "revoke_failed")) }
case "settings":
    let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    emit(result(NSWorkspace.shared.open(url) ? "awaiting_authorization" : "error", "full_disk_manual"))
default:
    emit(result("error", "invalid_command"))
    Darwin.exit(1)
}
