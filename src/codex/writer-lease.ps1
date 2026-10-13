$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class GateLock {
 [StructLayout(LayoutKind.Sequential)] public struct Overlap { public IntPtr Internal,InternalHigh; public uint Offset,OffsetHigh; public IntPtr Event; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool LockFileEx(SafeFileHandle h,uint flags,uint reserved,uint low,uint high,ref Overlap o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UnlockFileEx(SafeFileHandle h,uint reserved,uint low,uint high,ref Overlap o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 public static int Lock(FileStream f) { var o=new Overlap();return LockFileEx(f.SafeFileHandle,3,0,uint.MaxValue,uint.MaxValue,ref o)?0:Marshal.GetLastWin32Error(); }
 public static void Unlock(FileStream f) {var o=new Overlap();if(!UnlockFileEx(f.SafeFileHandle,0,uint.MaxValue,uint.MaxValue,ref o))throw new IOException("Unlock failed");}
 public static string Identity(FileStream f) {Info i;if(!GetFileInformationByHandle(f.SafeFileHandle,out i))throw new IOException("Identity failed");return i.Volume+":"+i.IndexHigh+":"+i.IndexLow;}
}
'@
$held = @{}
function Open-ReadOnly([string]$path) { [IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)) }
try {
 while ($null -ne ($line = [Console]::ReadLine())) {
  try {
   $command = $line | ConvertFrom-Json
   if ($command.action -eq 'retain') {
    $file = Open-ReadOnly $command.path
    $held[$command.key] = @{ file=$file; path=$command.path; identity=[GateLock]::Identity($file) }
    $result = @{ retained=$true; identity=$held[$command.key].identity }
   } elseif ($command.action -eq 'probe') {
    $entry = $held[$command.key];if(!$entry){throw 'Unknown handle'}
    $coord = Open-ReadOnly $command.coordination
    $coordError = [GateLock]::Lock($coord)
    try {
     if($coordError -ne 0){$result=@{ coordinationError=$coordError }} else {
      $pathPresent=$false;$sameIdentity=$null;$currentLockError=$null;$current=$null
      try{$current=Open-ReadOnly $entry.path;$pathPresent=$true}catch [IO.FileNotFoundException]{}catch [IO.DirectoryNotFoundException]{}
      if($current){try{$sameIdentity=([GateLock]::Identity($current) -eq $entry.identity);$currentLockError=[GateLock]::Lock($current);if($currentLockError -eq 0){[GateLock]::Unlock($current)}}finally{$current.Dispose()}}
      $lockError=[GateLock]::Lock($entry.file)
      if($lockError -eq 0){[GateLock]::Unlock($entry.file)}
      $result=@{ lockError=$lockError; pathPresent=$pathPresent; sameIdentity=$sameIdentity; currentLockError=$currentLockError; coordinationLocked=$true; positiveReleased=($lockError -eq 0 -and (!$pathPresent -or $sameIdentity)) }
     }
    } finally {if($coordError -eq 0){[GateLock]::Unlock($coord)};$coord.Dispose()}
   } else {throw 'Unknown action'}
   $result | ConvertTo-Json -Compress | ForEach-Object {[Console]::WriteLine($_)}
  } catch {
   $exception=$_.Exception
   while($exception.InnerException){$exception=$exception.InnerException}
   $message=$exception.Message;if($message.Length -gt 1024){$message=$message.Substring(0,1024)}
   @{error=@{type=$exception.GetType().FullName;message=$message;win32Error=($exception.HResult -band 65535)}} | ConvertTo-Json -Compress | ForEach-Object {[Console]::WriteLine($_)}
  }
 }
} finally {foreach($entry in $held.Values){$entry.file.Dispose()}}
