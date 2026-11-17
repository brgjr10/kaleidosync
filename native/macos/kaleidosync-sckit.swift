// Kaleidosync macOS audio helper (ScreenCaptureKit).
//
// Emits raw PCM on stdout in the exact format the rest of the app expects:
//   32-bit float little-endian, 48000 Hz, 2 channels interleaved (L R L R ...).
//
// Modes:
//   --check                  Exit 0 when capture is possible, 1 otherwise.
//                            Prints a JSON object {"ok":bool,"detail":"..."} on stdout.
//   --list                   Print a JSON array of capture sources on stdout.
//   --capture system         Capture everything the OS is playing.
//   --capture pid:<pid>      Capture only one application's audio.
//
// Source ids produced by --list:
//   "system"      system-wide audio (always present)
//   "pid:<pid>"   one running application's audio
//
// ScreenCaptureKit provides audio-only capture on macOS 12.3+, and per-app
// audio through SCContentFilter(includingApplications:). No virtual audio
// device (BlackHole, Loopback) is required.
//
// Build (on macOS):
//   swiftc -O -target arm64-apple-macos13 \
//     -framework ScreenCaptureKit -framework CoreMedia -framework CoreGraphics \
//     -framework AppKit -framework AVFAudio \
//     -o kaleidosync-sckit kaleidosync-sckit.swift
//
// The Electron app needs Screen Recording permission; a helper spawned by the
// app inherits the responsible process's TCC decision.

import AVFAudio
import AppKit
import CoreGraphics
import CoreMedia
import Dispatch
import Foundation
import ScreenCaptureKit

// MARK: - PCM output

private let outputQueue = DispatchQueue(label: "kaleidosync.pcm")

private func writeData(_ data: Data) {
    outputQueue.sync {
        FileHandle.standardOutput.write(data)
    }
}

private func writeSamples(_ samples: [Float32]) {
    samples.withUnsafeBytes { raw in
        writeData(Data(bytes: raw.baseAddress!, count: raw.count))
    }
}

private func log(_ message: String) {
    FileHandle.standardError.write(Data(("[kaleidosync-sckit] " + message + "\n").utf8))
}

private func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out += "\""
    return out
}

// Convert one SCStream audio sample buffer to interleaved float32.
//
// ScreenCaptureKit normally delivers 32-bit float, non-interleaved planar
// audio. The stream layout is read through AVAudioFormat(cmFormatDescription:)
// rather than CMAudioFormatDescriptionGetStreamLayout, which is not exposed to
// Swift in current SDKs. Interleaved float and signed 16-bit are handled too so
// a format change cannot silently mute the app.
private func writeSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
    guard sampleBuffer.isValid else { return }
    let frameCount = Int(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0 else { return }

    guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
          let format = AVAudioFormat(cmFormatDescription: formatDescription) else { return }

    let channels = Int(format.channelCount)
    guard channels > 0 else { return }

    guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let byteCount = CMBlockBufferGetDataLength(blockBuffer)
    guard byteCount > 0 else { return }

    var dataPointer: UnsafeMutablePointer<Int8>?
    let status = CMBlockBufferGetDataPointer(blockBuffer,
                                             atOffset: 0,
                                             length: byteCount,
                                             outDataPointer: &dataPointer)
    guard status == noErr, let dataPointer = dataPointer else { return }
    let raw = Data(bytes: UnsafeRawPointer(dataPointer), count: byteCount)

    let isFloat = format.commonFormat == .pcmFormatFloat32
    let isNonInterleaved = !format.isInterleaved

    if isFloat && isNonInterleaved {
        let channelBytes = frameCount * 4
        guard byteCount >= channelBytes * channels else { return }
        var interleaved = [Float32](repeating: 0, count: frameCount * channels)
        raw.withUnsafeBytes { src in
            let pointer = src.baseAddress!.assumingMemoryBound(to: Float32.self)
            for frame in 0..<frameCount {
                for channel in 0..<channels {
                    interleaved[frame * channels + channel] =
                        pointer[channel * frameCount + frame]
                }
            }
        }
        writeSamples(interleaved)
        return
    }

    if isFloat {
        let expected = frameCount * channels * 4
        guard byteCount >= expected else { return }
        raw.withUnsafeBytes { src in
            writeData(Data(bytes: src.baseAddress!, count: expected))
        }
        return
    }

    if format.commonFormat == .pcmFormatInt16 && isNonInterleaved {
        let sampleCount = frameCount * channels
        guard byteCount >= sampleCount * 2 else { return }
        var converted = [Float32](repeating: 0, count: sampleCount)
        raw.withUnsafeBytes { src in
            let source = src.baseAddress!.assumingMemoryBound(to: Int16.self)
            for frame in 0..<frameCount {
                for channel in 0..<channels {
                    converted[frame * channels + channel] =
                        Float32(source[channel * frameCount + frame]) / 32768.0
                }
            }
        }
        writeSamples(converted)
        return
    }

    if format.commonFormat == .pcmFormatInt16 {
        let sampleCount = frameCount * channels
        guard byteCount >= sampleCount * 2 else { return }
        var converted = [Float32](repeating: 0, count: sampleCount)
        raw.withUnsafeBytes { src in
            let source = src.baseAddress!.assumingMemoryBound(to: Int16.self)
            for index in 0..<sampleCount {
                converted[index] = Float32(source[index]) / 32768.0
            }
        }
        writeSamples(converted)
        return
    }

    log("unsupported audio format: \(format.commonFormat.rawValue)")
}

// MARK: - Screen capture

private var activeStream: SCStream?
// SCStream keeps its output delegate weakly in some SDK releases, so hold a
// strong reference for the lifetime of the capture.
private var audioDelegate: AudioCaptureDelegate?

private final class AudioCaptureDelegate: NSObject, SCStreamOutput {
    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return }
        writeSampleBuffer(sampleBuffer)
    }
}

// ScreenCaptureKit exposes the system-audio switch as an Objective-C property
// whose Swift name has changed across SDK releases. Set it by selector so the
// helper builds against any recent SDK and still enables audio at runtime.
private func enableSystemAudio(_ configuration: SCStreamConfiguration) {
    let candidates = [
        "capturesSystemAudioEnabled",
        "captureSystemAudioEnabled",
        "systemAudioEnabled"
    ]
    for key in candidates {
        let setter = "set" + key.prefix(1).uppercased() + String(key.dropFirst()) + ":"
        if configuration.responds(to: NSSelectorFromString(setter)) {
            configuration.setValue(true, forKey: key)
            return
        }
    }
    log("warning: no system-audio switch found on SCStreamConfiguration")
}

private func makeConfiguration() -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    // Audio-only capture still requires a non-zero frame size.
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
    configuration.sampleRate = 48000
    configuration.channelCount = 2
    configuration.showsCursor = false
    configuration.queueDepth = 5
    enableSystemAudio(configuration)
    return configuration
}

// Apps that never produce user-visible audio; listing them as capture targets
// would only add noise to the source dropdown.
private let excludedBundleIds: Set<String> = [
    "com.apple.finder",
    "com.apple.dock",
    "com.apple.systemuiserver",
    "com.apple.controlcenter",
    "com.apple.notificationcenterui",
    "com.apple.spotlight",
    "com.apple.camera.mdservice",
    "com.apple.WindowServer",
    "com.apple.wallpaper.agent",
    "com.apple.loginwindow",
    "com.apple.backgroundtaskmanagement",
    "com.apple.amsaccountsd",
    "com.apple.parsecd"
]

private func loadContent() async throws -> SCShareableContent {
    try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
}

private func listSources() async throws {
    let content = try await loadContent()
    guard !content.displays.isEmpty else {
        throw NSError(domain: "kaleidosync", code: 1,
                      userInfo: [NSLocalizedDescriptionKey:
                          "ScreenCaptureKit returned no displays"])
    }

    var parts: [String] = []
    parts.append("{\"id\":\"system\",\"name\":\"System Audio\","
                 + "\"type\":\"monitor\",\"isDefault\":true}")

    var seen = Set<pid_t>()
    for application in content.applications {
        let pid = application.processID
        if pid == getpid() || seen.contains(pid) { continue }
        let bundle = application.bundleIdentifier
        if excludedBundleIds.contains(bundle) { continue }
        seen.insert(pid)
        parts.append("{\"id\":\"pid:\(pid)\",\"name\":\(jsonString(application.applicationName)),"
                     + "\"type\":\"application\",\"pid\":\(pid),"
                     + "\"bundleId\":\(jsonString(bundle))}")
    }

    print("[" + parts.joined(separator: ",") + "]")
    fflush(stdout)
}

private func makeStream(pid: pid_t?) async throws -> SCStream {
    let content = try await loadContent()
    guard let display = content.displays.first else {
        throw NSError(domain: "kaleidosync", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "no display available"])
    }

    let filter: SCContentFilter
    if let pid = pid {
        guard let application = content.applications.first(where: {
            $0.processID == pid
        }) else {
            throw NSError(domain: "kaleidosync", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "process \(pid) not found"])
        }
        filter = SCContentFilter(display: display,
                                 includingApplications: [application],
                                 exceptingWindows: [])
    } else {
        filter = SCContentFilter(display: display, excludingWindows: [])
    }

    let stream = SCStream(filter: filter,
                          configuration: makeConfiguration(),
                          delegate: nil)
    let delegate = AudioCaptureDelegate()
    audioDelegate = delegate
    try stream.addStreamOutput(delegate,
                               type: .audio,
                               sampleHandlerQueue: DispatchQueue(label: "kaleidosync.audio"))
    try await stream.startCapture()
    return stream
}

// MARK: - Entry point

private func fail(_ message: String) -> Never {
    log(message)
    print("{\"ok\":false,\"detail\":\(jsonString(message))}")
    fflush(stdout)
    exit(1)
}

private func check() async {
    do {
        let content = try await loadContent()
        if content.displays.isEmpty {
            print("{\"ok\":false,\"detail\":\"ScreenCaptureKit returned no displays\"}")
        } else {
            print("{\"ok\":true,\"detail\":\"ScreenCaptureKit available\"}")
        }
        fflush(stdout)
    } catch {
        print("{\"ok\":false,\"detail\":\(jsonString("\(error)"))}")
        fflush(stdout)
        exit(1)
    }
}

let arguments = CommandLine.arguments

guard arguments.count >= 2 else {
    fail("usage: kaleidosync-sckit --check | --list | --capture <system|pid:N>")
}

let mode = arguments[1]
var targetPid: pid_t?

if mode == "--capture" {
    guard arguments.count >= 3 else {
        fail("--capture requires <system|pid:N>")
    }
    let target = arguments[2]
    if target != "system" {
        guard target.hasPrefix("pid:"), let pid = pid_t(target.dropFirst(4)), pid > 0 else {
            fail("--capture target must be 'system' or 'pid:<pid>'")
        }
        targetPid = pid
    }
}

switch mode {
case "--check":
    let finished = DispatchSemaphore(value: 0)
    Task {
        await check()
        finished.signal()
    }
    finished.wait()

case "--list":
    let finished = DispatchSemaphore(value: 0)
    Task {
        do {
            try await listSources()
        } catch {
            fail("\(error)")
        }
        finished.signal()
    }
    finished.wait()

case "--capture":
    let started = DispatchSemaphore(value: 0)
    Task {
        do {
            activeStream = try await makeStream(pid: targetPid)
        } catch {
            fail("failed to start ScreenCaptureKit capture: \(error)")
        }
        started.signal()
    }
    started.wait()
    dispatchMain()

default:
    fail("unknown mode")
}