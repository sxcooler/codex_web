using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
[assembly: AssemblyTitle("codex_web")]
[assembly: AssemblyDescription("codex_web")]
[assembly: AssemblyProduct("codex_web")]
internal static class StartupLauncher {
    [STAThread]
    private static int Main() {
        try {
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
            start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(root, @"scripts\windows\start-server.ps1") + "\" -Background";
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (var process = Process.Start(start)) { process.WaitForExit(); return process.ExitCode; }
        } catch { return 1; }
    }
}
