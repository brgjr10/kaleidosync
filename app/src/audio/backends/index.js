import { LinuxBackend } from './linux.js';
import { WindowsBackend } from './windows.js';
import { DarwinBackend } from './darwin.js';

// Platform backend registry.
//
// Every backend implements the same contract so audio-capture.js (and the whole
// analysis → uniform → shader pipeline) is shared verbatim across platforms:
//
//   id                   'linux' | 'win32' | 'darwin'
//   label                human readable backend name
//   supportsMetadata     getMetadata()/sendCommand() are meaningful
//   supportsProcessAudio per-application capture is available
//   status               { available, detail, hint }
//   init()               detect tooling
//   enumerate()          -> [source]
//   buildCapture(source) -> { command, args } | null
//   startPolling(source, onPlayback) / stopPolling()
//   getMetadata(source)  -> metadata | null
//   sendCommand(source, command) -> bool
//
// A source is always:
//   { id, name, type: 'application' | 'monitor', hostAPI, ... }
//   'application' = one app's audio (subject to play/pause gating)
//   'monitor'     = everything the OS is playing (never gated)

export function createBackend(platform = process.platform) {
  switch (platform) {
    case 'win32':
      return new WindowsBackend();
    case 'darwin':
      return new DarwinBackend();
    default:
      return new LinuxBackend();
  }
}

export { LinuxBackend, WindowsBackend, DarwinBackend };