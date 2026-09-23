param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Worker,
    [Parameter(Mandatory = $true)][string]$Spec,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopWindowProbe
{
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    public static long ForegroundHandle()
    {
        return GetForegroundWindow().ToInt64();
    }

    public static string ForegroundIdentity()
    {
        IntPtr window = GetForegroundWindow();
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        string name = "unknown";
        try { name = Process.GetProcessById((int)processId).ProcessName.ToLowerInvariant(); } catch { }
        return window.ToInt64().ToString() + "|" + processId.ToString() + "|" + name;
    }

    public static long[] VisibleBrowserHandles()
    {
        List<long> handles = new List<long>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window)) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            try {
                string name = Process.GetProcessById((int)processId).ProcessName.ToLowerInvariant();
                if (name == "chrome" || name == "msedge") handles.Add(window.ToInt64());
            } catch { }
            return true;
        }, IntPtr.Zero);
        return handles.ToArray();
    }
}
'@

$beforeFocus = [DesktopWindowProbe]::ForegroundHandle()
$beforeIdentity = [DesktopWindowProbe]::ForegroundIdentity()
$baselineBrowsers = @([DesktopWindowProbe]::VisibleBrowserHandles())
$argumentList = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    (Join-Path $PSScriptRoot 'run-hidden-desktop.ps1'),
    '-Executable', $Executable,
    '-Worker', $Worker,
    '-Spec', $Spec,
    '-WorkingDirectory', $WorkingDirectory
)
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = 'powershell.exe'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($argument in $argumentList) { [void]$start.ArgumentList.Add($argument) }
$process = [System.Diagnostics.Process]::Start($start)
$focusChanges = [System.Collections.Generic.HashSet[string]]::new()
$newBrowserWindows = [System.Collections.Generic.HashSet[long]]::new()
while (-not $process.HasExited) {
    $focus = [DesktopWindowProbe]::ForegroundHandle()
    if ($focus -ne $beforeFocus) { [void]$focusChanges.Add([DesktopWindowProbe]::ForegroundIdentity()) }
    foreach ($handle in [DesktopWindowProbe]::VisibleBrowserHandles()) {
        if ($baselineBrowsers -notcontains $handle) { [void]$newBrowserWindows.Add($handle) }
    }
    Start-Sleep -Milliseconds 100
}
$process.WaitForExit()
$runnerOutput = $process.StandardOutput.ReadToEnd().Trim()
$runnerError = $process.StandardError.ReadToEnd().Trim()
[ordered]@{
    exitCode = $process.ExitCode
    foregroundUnchanged = ($focusChanges.Count -eq 0)
    newVisibleBrowserWindows = $newBrowserWindows.Count
    samplesWithDifferentForeground = $focusChanges.Count
    initialForeground = $beforeIdentity
    changedForegrounds = @($focusChanges)
    runnerOutputPresent = [bool]$runnerOutput
    runnerError = if ($runnerError) { $runnerError.Substring(0, [Math]::Min(300, $runnerError.Length)) } else { '' }
} | ConvertTo-Json -Compress
exit $process.ExitCode
