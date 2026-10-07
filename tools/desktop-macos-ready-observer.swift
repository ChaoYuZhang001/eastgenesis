// Persistent, owned-PID AX readiness probe. It never submits a task.
import Foundation
import AppKit
import ApplicationServices

func stamp() -> Double { Date().timeIntervalSince1970 * 1000 }
func mono() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}
func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success ? result : nil
}
func text(_ element: AXUIElement, _ attribute: String) -> String {
    value(element, attribute) as? String ?? ""
}
func name(_ element: AXUIElement) -> String {
    let title = text(element, kAXTitleAttribute)
    return title.isEmpty ? text(element, kAXDescriptionAttribute) : title
}
func labels(_ element: AXUIElement) -> [String] {
    [text(element, kAXTitleAttribute), text(element, kAXDescriptionAttribute)]
}
func frame(_ element: AXUIElement) -> CGRect? {
    guard let point = value(element, kAXPositionAttribute), let size = value(element, kAXSizeAttribute),
          CFGetTypeID(point) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero; var s = CGSize.zero
    guard AXValueGetValue(point as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s),
          s.width > 0, s.height > 0 else { return nil }
    return CGRect(origin: p, size: s)
}
func visible(_ element: AXUIElement, in window: CGRect?) -> Bool {
    guard let window, let rect = frame(element) else { return false }
    return rect.intersects(window) && (value(element, "AXHidden") as? Bool) != true
}
func enabled(_ element: AXUIElement) -> Bool {
    (value(element, kAXEnabledAttribute) as? Bool) == true
}
struct Snapshot {
    var complete = true
    var hasWindow = false
    var windowVisible = false
    var windowFrame: CGRect?
    var webArea = false
    var splash = false
    var input: AXUIElement?
    var submit: AXUIElement?
    var route: AXUIElement?
    var manual: AXUIElement?
    var model: AXUIElement?
    var automatic: AXUIElement?
    var provider = false
    var providerVisible = false
    var modelVisible = false
    var inputValue = ""
    var inputVisible = false
    var routeVisible = false
    var nodes = 0
}
func scan(_ app: AXUIElement, modelName: String) -> Snapshot {
    var result = Snapshot()
    let start = mono()
    let windows = value(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    result.hasWindow = !windows.isEmpty
    if let window = windows.first, (value(window, kAXMinimizedAttribute) as? Bool) == false {
        result.windowFrame = frame(window)
        result.windowVisible = result.windowFrame != nil
    }
    var queue = windows
    var index = 0
    while index < queue.count {
        if result.nodes >= 4096 || mono() - start > 100 {
            result.complete = false
            break
        }
        let element = queue[index]; index += 1; result.nodes += 1
        let role = text(element, kAXRoleAttribute)
        if role == "AXWebArea" { result.webArea = true }
        if role == kAXTextAreaRole, labels(element).contains("任务描述"), result.input == nil {
            result.input = element
            result.inputValue = text(element, kAXValueAttribute)
            result.inputVisible = visible(element, in: result.windowFrame)
        }
        if role == kAXButtonRole || role == kAXPopUpButtonRole || role == kAXMenuItemRole || role == "AXRadioButton" {
            let names = labels(element)
            if names.contains("提交任务") { result.submit = element }
            if names.contains("路由") { result.route = element; result.routeVisible = visible(element, in: result.windowFrame) }
            if names.contains(where: { $0.contains("手动锁定") }) { result.manual = element }
            if names.contains(modelName) { result.model = element; result.modelVisible = visible(element, in: result.windowFrame) }
            if names.contains(where: { $0.contains("自动（推荐）") }) { result.automatic = element }
        }
        if role == kAXStaticTextRole {
            let label = text(element, kAXValueAttribute)
            if label == "从想法，到成果" { result.splash = true }
            if label == "QA Fixture" { result.provider = true; result.providerVisible = visible(element, in: result.windowFrame) }
        }
        if role == kAXImageRole && name(element) == "EastGenesis 标志" { result.splash = true }
        if let children = value(element, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children)
        }
    }
    return result
}
func press(_ element: AXUIElement) -> Bool {
    AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}
func replaceText(_ element: AXUIElement, with string: String) -> Bool {
    // AX text replacement is checked against React's submit enabled state on
    // a later scan. No Enter/submit action or clipboard mutation is used.
    guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { return false }
    return AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, string as CFString) == .success
}

let trusted = AXIsProcessTrusted()
emit(["event": "observer_ready", "wallTimeMs": stamp(), "trusted": trusted])
guard trusted else { exit(2) }
while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          command["command"] as? String == "observe",
          let pidNumber = command["pid"] as? Int, pidNumber > 0,
          let timeout = command["timeoutMs"] as? Double, timeout >= 1000, timeout <= 30000,
          let poll = command["pollMs"] as? Double, poll >= 20, poll <= 100,
          let token = command["token"] as? String else {
        emit(["event": "protocol_error", "wallTimeMs": stamp()]); continue
    }
    let pid = pid_t(pidNumber)
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.025)
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, _, _, _ in }
    let observerResult = AXObserverCreate(pid, callback, &observer)
    var notifications = 0
    if observerResult == .success, let observer {
        for notification in [kAXWindowCreatedNotification, kAXFocusedUIElementChangedNotification] {
            if AXObserverAddNotification(observer, app, notification as CFString, nil) == .success { notifications += 1 }
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }
    func event(_ event: String, _ fields: [String: Any] = [:]) {
        var output = fields
        output["event"] = event; output["pid"] = pidNumber; output["token"] = token; output["wallTimeMs"] = stamp()
        emit(output)
    }
    event("attached", ["axObserverCreated": observerResult == .success, "notificationCount": notifications])
    let deadline = mono() + timeout
    let prompt = "qa startup readiness probe"
    var basic = false; var roundtrip = false; var routeOpened = false; var manualOpened = false
    var promptWritten = false; var clearing = false; var routeVerified = false
    var activated = false; var count = 0; var last: Double?
    var maxGap = 0.0; var maxScan = 0.0; var totalScan = 0.0; var incomplete = 0
    var latest = Snapshot()
    var scanStartedWall = 0.0; var scanCompletedWall = 0.0; var previousScanCompletedWall = 0.0
    var failedStage: String?
    var completed = false
    while mono() < deadline {
        let iterationStart = mono()
        if !activated, let running = NSRunningApplication(processIdentifier: pid) {
            activated = running.activate(options: [])
        }
        let scanStart = mono()
        scanStartedWall = stamp()
        if let last { maxGap = max(maxGap, scanStart - last) }
        last = scanStart
        previousScanCompletedWall = scanCompletedWall
        latest = scan(app, modelName: "gpt-5.6-luna")
        scanCompletedWall = stamp()
        let duration = mono() - scanStart
        count += 1; maxScan = max(maxScan, duration); totalScan += duration
        if !latest.complete { incomplete += 1 }
        let appActive = NSRunningApplication(processIdentifier: pid)?.isActive == true
        if latest.complete, latest.windowVisible, appActive, latest.webArea, !latest.splash, latest.inputVisible, latest.routeVisible,
           let input = latest.input, enabled(input), let route = latest.route, enabled(route) {
            if !basic {
                basic = true
                event("startup_basic_ready", ["splashAbsent": true, "ownedWindowVisible": true, "ownedAppActive": true, "webAreaPresent": true, "inputVisible": true, "inputEnabled": true, "routeControlVisible": true, "routeControlEnabled": true, "scanStartedWallMs": scanStartedWall, "scanCompletedWallMs": scanCompletedWall, "previousScanCompletedWallMs": previousScanCompletedWall])
            }
            if !promptWritten {
                guard replaceText(input, with: prompt) else { failedStage = "ax_prompt_write"; break }
                promptWritten = true
            } else if !roundtrip, latest.inputValue == prompt, let submit = latest.submit, enabled(submit) {
                roundtrip = true
                event("input_roundtrip_submit_enabled", ["promptReadBack": true, "submitEnabled": true, "scanStartedWallMs": scanStartedWall, "scanCompletedWallMs": scanCompletedWall, "previousScanCompletedWallMs": previousScanCompletedWall])
            }
            if roundtrip && !routeOpened {
                guard press(route) else { failedStage = "ax_route_open"; break }
                routeOpened = true
            } else if routeOpened && !manualOpened, let manual = latest.manual, enabled(manual) {
                guard press(manual) else { failedStage = "ax_manual_menu_open"; break }
                manualOpened = true
            } else if manualOpened && !routeVerified, latest.providerVisible, latest.modelVisible, let model = latest.model, enabled(model) {
                routeVerified = true
                event("route_provider_probe_completed", ["qaProviderVisible": true, "qaModelEnabled": true, "modelSelected": false, "scanStartedWallMs": scanStartedWall, "scanCompletedWallMs": scanCompletedWall, "previousScanCompletedWallMs": previousScanCompletedWall])
                // Reset through the real enabled automatic-mode action rather
                // than infer the trigger's mode from unexposed AX child text.
                guard let automatic = latest.automatic, enabled(automatic), press(automatic) else { failedStage = "ax_routing_reset"; break }
                event("automatic_routing_reset_action", ["automaticRoutingResetActionsIssued": 1, "modelSelectionActionsIssued": 0, "submitActionsIssued": 0])
                guard replaceText(input, with: "") else { failedStage = "ax_draft_clear"; break }
                clearing = true
            } else if clearing, latest.inputValue.isEmpty, let submit = latest.submit, !enabled(submit), latest.manual == nil {
                completed = true
                event("probe_reset_completed", ["inputCleared": true, "submitDisabledAgain": true, "routingMenuClosed": true, "automaticRoutingResetThroughEnabledMenuItem": true, "modelSelectionActionsIssued": 0])
                break
            }
        }
        let remaining = max(0, poll - (mono() - iterationStart))
        _ = CFRunLoopRunInMode(.defaultMode, remaining / 1000, false)
    }
    if let observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }
    event(completed ? "completed" : "failed", [
        "failedStage": failedStage ?? (completed ? "" : "readiness_timeout"),
        "conditions": ["startupBasicReady": basic, "inputRoundtripSubmitEnabled": roundtrip, "routeProviderProbeCompleted": routeVerified, "probeResetCompleted": completed],
        "scanCount": count, "targetPollMs": poll, "maxObservationGapMs": maxGap,
        "maxScanDurationMs": maxScan, "meanScanDurationMs": count > 0 ? totalScan / Double(count) : 0,
        "incompleteScanCount": incomplete, "latestScanComplete": latest.complete,
        "latestConditions": ["window": latest.hasWindow, "windowVisible": latest.windowVisible, "appActive": NSRunningApplication(processIdentifier: pid)?.isActive == true, "webArea": latest.webArea, "splashVisible": latest.splash, "input": latest.input != nil, "inputVisible": latest.inputVisible, "submit": latest.submit != nil, "route": latest.route != nil, "routeVisible": latest.routeVisible, "manual": latest.manual != nil, "provider": latest.provider, "model": latest.model != nil]
    ])
}
