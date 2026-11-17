param(
  [Parameter(Mandatory = $true)][int]$AppProcessId,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'E2E export requires a new output file' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class E2EDialogNative {
  private delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int maxCount);
  public static IntPtr FindOwnedDialog(uint expectedPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, parameter) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != expectedPid) return true;
      var name = new System.Text.StringBuilder(256);
      GetClassName(hwnd, name, name.Capacity);
      if (name.ToString() != "#32770") return true;
      found = hwnd; return false;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
  public static extern IntPtr SetText(IntPtr hwnd, uint message, IntPtr wparam, string text);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
  public static extern IntPtr ReadText(IntPtr hwnd, uint message, IntPtr count, System.Text.StringBuilder text);
  [DllImport("user32.dll", EntryPoint = "SendMessageW")]
  public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
function Get-OwnedHandle($element) {
  $handle = [IntPtr]::new([long]$element.Current.NativeWindowHandle)
  [uint32]$owner = 0
  [void][E2EDialogNative]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($handle -eq [IntPtr]::Zero -or $owner -ne $AppProcessId) { throw 'Dialog control does not belong to E2E process' }
  return $handle
}
$deadline = [DateTime]::UtcNow.AddSeconds(45)
$dialog = $null
do {
  # Enumerate owned top-level windows first. Searching the entire desktop's
  # accessibility tree can miss a newly opened dialog while other apps redraw.
  $ownedDialog = [E2EDialogNative]::FindOwnedDialog([uint32]$AppProcessId)
  if ($ownedDialog -ne [IntPtr]::Zero) {
    $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($ownedDialog)
  }
  if (-not $dialog) { Start-Sleep -Milliseconds 150 }
} until ($dialog -or [DateTime]::UtcNow -gt $deadline)
if (-not $dialog) { throw "No native file dialog for E2E process $AppProcessId" }
$filename = $null
do {
  # The filename edit and the address toolbar both use automation ID 1001.
  $filename = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001'),
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Edit')))
  if (-not $filename) { Start-Sleep -Milliseconds 150 }
} until ($filename -or [DateTime]::UtcNow -gt $deadline)
if (-not $filename) {
  $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  throw ('Native filename input not found: ' + (($controls | ForEach-Object { $_.Current.AutomationId + ':' + $_.Current.ControlType.ProgrammaticName }) -join ', '))
}
$dialogHandle = Get-OwnedHandle $dialog
$filenameHandle = Get-OwnedHandle $filename
[void][E2EDialogNative]::SetText($filenameHandle, 0x000C, [IntPtr]::Zero, $OutputPath)
$actualPath = [System.Text.StringBuilder]::new(32768)
[void][E2EDialogNative]::ReadText($filenameHandle, 0x000D, [IntPtr]::new($actualPath.Capacity), $actualPath)
if ($actualPath.ToString() -ne $OutputPath) { throw 'Native filename input did not accept the E2E export path' }
$save = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1'),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Button')))
if (-not $save) { throw 'Native Save button not found' }
$saveHandle = Get-OwnedHandle $save
$invoke = $null
if ($save.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
else { [void][E2EDialogNative]::SendMessage($saveHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
$closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
while ([E2EDialogNative]::IsWindow($dialogHandle) -and [DateTime]::UtcNow -lt $closeDeadline) { Start-Sleep -Milliseconds 150 }
if ([E2EDialogNative]::IsWindow($dialogHandle)) {
  $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $details = foreach ($control in $controls) {
    $controlValue = $null
    $valueText = ''
    if ($control.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$controlValue)) { $valueText = $controlValue.Current.Value }
    if ($control.Current.AutomationId -in @('1001','FileNameControlHost','1','ContentText')) { $control.Current.AutomationId + ':' + $control.Current.Name + ':' + $control.Current.ClassName + ':' + $control.Current.NativeWindowHandle + ':' + $valueText }
  }
  throw ("Native save dialog remains open for E2E process $AppProcessId`n" + ($details -join "`n"))
}
Write-Output "Saved through native dialog for E2E process $AppProcessId"
