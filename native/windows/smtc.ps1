# Kaleidosync Windows now-playing helper (System Media Transport Controls).
#
# SMTC is the Windows 10/11 equivalent of Linux MPRIS: it exposes the track
# title/artist/album, playback status and transport commands for the app that
# currently owns audio. This script is the metadata half of the Windows
# backend; raw audio capture is handled by kaleidosync-wasapi.c.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File smtc.ps1 -Mode watch
#       Prints one compact JSON object per line, once a second, for every
#       registered media session:
#         {"status":"playing","title":"...","artist":"...","album":"...",
#          "appId":"...","pid":1234}
#       A source is matched to a session by pid (0 when it cannot be resolved).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File smtc.ps1 \
#       -Mode command -Pid 1234 -Command playpause
#       -Command accepts: playpause | next | previous
#       Exit code 0 means the session accepted the command.
#
# The script never throws: if WinRT or SMTC is unavailable it writes a single
# {"status":"unavailable"} line (watch) or exits non-zero (command), and the
# app simply hides the now-playing panel.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('watch', 'command')]
    [string]$Mode,

    [string]$Pid,

    [ValidateSet('playpause', 'next', 'previous')]
    [string]$Command
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $null = $netTask.Wait(-1)
    $netTask.Result
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class KaleidosyncProcessInfo {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);

    public static string GetAumi(int pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return null;
        try {
            uint length = 0;
            GetApplicationUserModelId(handle, ref length, null);
            if (length == 0) return null;
            StringBuilder builder = new StringBuilder((int)length);
            if (GetApplicationUserModelId(handle, ref length, builder) != 0) return null;
            return builder.ToString();
        } catch {
            return null;
        } finally {
            CloseHandle(handle);
        }
    }
}
"@

function Get-Manager {
    Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Get-Sessions($manager) {
    $manager.GetSessions()
}

function Get-Properties($session) {
    Await ($session.TryGetMediaPropertiesAsync()) `
        ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
}

function Get-StatusText($session) {
    $info = $session.GetPlaybackInfo()
    if ($null -eq $info) { return 'stopped' }
    switch ([int]$info.PlaybackStatus) {
        3 { return 'playing' }
        2 { return 'paused' }
        4 { return 'stopped' }
        1 { return 'opened' }
        default { return 'stopped' }
    }
}

function Get-AumiMap {
    $map = @{}
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        $aumi = [KaleidosyncProcessInfo]::GetAumi($process.Id)
        if ($aumi) { $map[$aumi] = $process.Id }
    }
    $map
}

function Resolve-Pid($session, $aumiMap) {
    $aumi = $session.SourceAppUserModelId
    if (-not $aumi) { return 0 }
    if ($aumiMap.ContainsKey($aumi)) { return [int]$aumiMap[$aumi] }
    # Unpackaged Win32 apps do not expose an AUMI, so SMTC falls back to
    # "<image name>_<hash>!App". Match on the image name.
    $stem = ($aumi -split '[_!]')[0]
    if ($stem) {
        $stem = $stem -replace '\.exe$', ''
        $match = Get-Process -Name $stem -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($match) { return [int]$match.Id }
    }
    return 0
}

function Emit-Session($session, $aumiMap) {
    $properties = Get-Properties $session
    $status = Get-StatusText $session
    $pid = Resolve-Pid $session $aumiMap
    $payload = [ordered]@{
        status = $status
        title  = $properties.MusicName
        artist = $properties.Artist
        album  = $properties.AlbumTitle
        appId  = $session.SourceAppUserModelId
        pid    = $pid
    }
    $payload | ConvertTo-Json -Compress
}

function Find-Session($manager, $wantedPid) {
    $sessions = Get-Sessions $manager
    $aumiMap = Get-AumiMap
    if ($wantedPid -and $wantedPid -ne '0') {
        foreach ($session in $sessions) {
            if ((Resolve-Pid $session $aumiMap) -eq [int]$wantedPid) {
                return $session
            }
        }
        return $null
    }
    foreach ($session in $sessions) {
        if ((Get-StatusText $session) -eq 'playing') { return $session }
    }
    if ($sessions.Count -gt 0) { return $sessions[0] }
    return $null
}

try {
    $manager = Get-Manager
} catch {
    if ($Mode -eq 'watch') {
        '{"status":"unavailable","detail":"SMTC request failed"}'
    }
    exit 1
}

if ($Mode -eq 'watch') {
    while ($true) {
        try {
            $aumiMap = Get-AumiMap
            foreach ($session in Get-Sessions $manager) {
                Emit-Session $session $aumiMap
            }
        } catch {
            # A transient failure must not kill the watcher; the next tick retries.
        }
        Start-Sleep -Milliseconds 1000
    }
}

if ($Mode -eq 'command') {
    $session = Find-Session $manager $Pid
    if ($null -eq $session) { exit 1 }

    $ok = $false
    switch ($Command) {
        'playpause' { $ok = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
        'next'      { $ok = Await ($session.TrySkipNextAsync()) ([bool]) }
        'previous'  { $ok = Await ($session.TrySkipPreviousAsync()) ([bool]) }
    }
    if ($ok) { exit 0 }
    exit 1
}