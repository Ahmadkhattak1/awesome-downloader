using System;
using System.IO;
using System.Diagnostics;
using System.Threading;

// Binary-safe native messaging launcher. Never write diagnostics to stdout.
class NativeHostLauncher {
    static void Relay(Stream input, Stream output) {
        var buffer = new byte[8192]; int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, count); output.Flush();
        }
    }
    static int Main() {
        try {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string runtime = File.ReadAllText(Path.Combine(folder, "runtime-path.txt")).Trim();
            var info = new ProcessStartInfo(runtime, "\"" + Path.Combine(folder, "native-host.cjs") + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            using (var child = Process.Start(info)) {
                child.ErrorDataReceived += (sender, args) => { if (args.Data != null) Console.Error.WriteLine(args.Data); };
                child.BeginErrorReadLine();
                ThreadPool.QueueUserWorkItem(_ => {
                    try { Relay(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch (IOException) { }
                    finally { try { child.StandardInput.Close(); } catch { } }
                });
                Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                child.WaitForExit();
                return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
