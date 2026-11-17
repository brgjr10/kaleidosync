import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import * as fs from 'fs';

// Shared helpers for the platform audio backends.
//
// Every backend must emit raw PCM on stdout in exactly this format:
//
//   codec      : 32-bit float, little endian (f32le)
//   sample rate: 48000 Hz
//   channels   : 2, interleaved (L R L R ...)
//
// audio-capture.js slices that stream into 4096-byte frames and never needs to
// know which platform produced it. Keeping the format fixed is what makes the
// DSP (volume / stream / bass / treble / BPM) behave identically on Linux,
// Windows and macOS.

const PATH_DELIMITER = process.platform === 'win32' ? ';' : ':';

// Command names are fixed literals owned by the backends (pw-dump, pactl,
// ffmpeg, powershell, ...), never user input. spawn() without a shell and
// with an argument array is the safe way to invoke them.

export function hasBinary(name) {
  return new Promise((resolve) => {
    const args = name === 'ffmpeg' ? ['-version'] : ['--version'];
    // semgrep-ignore-next-line: intentional spawn to probe for a binary on PATH
    const proc = spawn(name, args);
    const finish = (value) => {
      if (proc.__settled) return;
      proc.__settled = true;
      resolve(value);
    };
    proc.on('error', () => finish(false));
    // Some tools return non-zero for --version but still exist.
    proc.on('close', () => finish(true));
  });
}

// Resolve an executable from PATH the way a shell would, without spawning it.
// Used to give a precise "install X" error instead of an ENOENT stack trace.
export function which(name) {
  const isWin = process.platform === 'win32';
  const pathEnv = process.env.PATH || (isWin ? '' : '/usr/bin:/bin');
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of pathEnv.split(PATH_DELIMITER)) {
    if (!dir) continue;
    for (const ext of exts) {
      // semgrep-ignore-next-line: PATH dirs are trusted; used to locate system binaries only
      const candidate = join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// Run a short-lived command and collect its stdout. Never rejects; returns
// { code, stdout, stderr, error } so backends can degrade gracefully when a
// tool is missing rather than throwing during startup.
export function runProcess(command, args, options = {}) {
  const { timeoutMs = 8000, maxBuffer = 8 * 1024 * 1024 } = options;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let proc;
    try {
      // semgrep-ignore-next-line: intentional spawn to run a short-lived command
      proc = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      done({ code: -1, stdout: '', stderr: '', error: err });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;

    const timer = setTimeout(() => {
      truncated = true;
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > maxBuffer) { stdout = stdout.slice(-maxBuffer); truncated = true; }
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr, error });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut: truncated && code !== 0 });
    });
  });
}

// Parse the first JSON document found in a chunk of text. Helpers may print
// banner lines before the payload, so scan for the first '{' or '[' and let
// JSON.parse tell us where the document ends.
export function parseJsonLoose(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the scan below
  }
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = ch === '{' ? trimmed.lastIndexOf('}') : trimmed.lastIndexOf(']');
    if (end === -1 || end < i) continue;
    try {
      return JSON.parse(trimmed.slice(i, end + 1));
    } catch {
      // try the next opening bracket
    }
  }
  return null;
}

// Cache directory for compiled helper binaries. Deliberately independent of
// Electron's app.getPath('userData') so the backends stay unit-testable and
// can be exercised from a plain node process.
export function cacheDir(name) {
  // semgrep-ignore-next-line: tmpdir() is an OS-controlled safe path
  const dir = join(tmpdir(), `kaleidosync-${name}-${process.platform}-${process.arch}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // fall through; the caller reports a useful error if the dir is unusable
  }
  return dir;
}

// Compile a helper once and reuse it. `build` returns { command, args } for
// the compiler invocation. Returns the path to the compiled artifact, or null
// when no compiler is available / the build failed. `onLog` receives compiler
// output so the caller can surface a real diagnostic instead of a silent
// "no sources" UI.
export async function ensureCompiled({ name, source, sources, build, onLog }) {
  const digest = createHash('sha256');
  digest.update(source);
  for (const extra of sources || []) digest.update(extra);
  const stamp = digest.digest('hex').slice(0, 16);

  const outDir = cacheDir(name);
  // semgrep-ignore-next-line: outDir comes from cacheDir() which uses tmpdir()
  const outPath = join(outDir, `${name}-${stamp}${process.platform === 'win32' ? '.exe' : ''}`);

  try {
    fs.accessSync(outPath, fs.constants.X_OK);
    return outPath;
  } catch {
    // not built yet (or not executable)
  }

  const spec = build(outPath);
  if (!spec) return null;

  const result = await runProcess(spec.command, spec.args, { timeoutMs: 120000 });
  if (result.error && result.error.code === 'ENOENT') {
    onLog?.(`build tool not found: ${spec.command}`);
    return null;
  }
  if (result.code !== 0 || result.error) {
    onLog?.(`build failed (${result.code ?? 'error'}): ${(result.stderr || '').trim()}`);
    return null;
  }
  try {
    fs.chmodSync(outPath, 0o755);
  } catch {
    // Windows ignores this; elsewhere it is a no-op best effort
  }
  return outPath;
}

// Terminate a capture process and any children it spawned. ffmpeg/native
// helpers do not fork, but pw-record/parec can under some session managers, so
// kill the tree when the platform supports it.
export function stopProcess(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      // semgrep-ignore-next-line: intentional spawn to terminate a process tree
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// Electron patches fs so paths inside app.asar appear readable, but a binary
// inside an asar cannot be executed by child_process. electron-builder's
// asarUnpack places native helpers in app.asar.unpacked, so prefer that copy
// whenever the candidate came from inside the archive.
export function preferUnpacked(candidate, mode = fs.constants.X_OK) {
  const marker = `app.asar${sep}`;
  if (!candidate.includes(marker)) return candidate;
  const unpacked = candidate.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  try {
    fs.accessSync(unpacked, mode);
    return unpacked;
  } catch {
    return candidate;
  }
}