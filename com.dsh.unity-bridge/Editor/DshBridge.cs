// DshBridge.cs — Unity editor bridge for DSH (C# side).
//
// Place under any `Assets/Editor/` folder. Adds a "Tools/DSH Bridge" menu with
// Start/Stop. Starts a minimal HTTP server on 127.0.0.1:6417 that the DSH
// `unity_execute` tool calls.
//
// Endpoints:
//   GET  /api/health    -> {"ok":true,"unity":"<version>","bridge":"0.1.0"}
//   POST /api/execute   body {"code":"<C# source>"}
//        -> 200 {"result":"<string>","logs":["<string>",...]}
//        -> 500 {"error":"<message>"}
//
// The submitted C# is compiled with CodeDom (CSharpCodeProvider) against every
// currently loaded assembly, so it can use UnityEngine / UnityEditor and your
// own game code. Use `return <expr>;` to return a value; Debug.Log* output is
// captured as `logs`. Code runs on the Unity main thread via an
// EditorApplication.update queue.
//
// Notes: an infinite loop will freeze the editor (same risk as any editor
// script). After an assembly reload (script changes) the server stops — click
// Start again.

using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using Microsoft.CSharp;
using UnityEditor;
using UnityEngine;

namespace DshBridge
{
    [Serializable]
    public class ExecuteRequest
    {
        public string code = "";
    }

    public static class Json
    {
        public static string Escape(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 16);
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    public static class CSharpEval
    {
        private static readonly string[] Usings =
        {
            "using System;",
            "using System.Collections;",
            "using System.Collections.Generic;",
            "using System.Linq;",
            "using UnityEngine;",
            "using UnityEditor;",
            "using Object = UnityEngine.Object;",
        };

        public static object Evaluate(string code)
        {
            var sb = new StringBuilder();
            foreach (var u in Usings) sb.AppendLine(u);
            sb.AppendLine("namespace __DshBridgeEval {");
            sb.AppendLine("public static class Eval {");
            sb.AppendLine("public static object Run() {");
            sb.AppendLine(code);
            sb.AppendLine("return null;");
            sb.AppendLine("}");
            sb.AppendLine("}");
            sb.AppendLine("}");

            using (var provider = new CSharpCodeProvider())
            {
                var cp = new CompilerParameters
                {
                    GenerateInMemory = true,
                    GenerateExecutable = false,
                    IncludeDebugInformation = false,
                };
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (asm.IsDynamic) continue;
                    try
                    {
                        if (!string.IsNullOrEmpty(asm.Location))
                            cp.ReferencedAssemblies.Add(asm.Location);
                    }
                    catch
                    {
                        // ignore assemblies whose location cannot be read
                    }
                }

                var results = provider.CompileAssemblyFromSource(cp, sb.ToString());
                if (results.Errors.HasErrors)
                {
                    var errs = new StringBuilder();
                    foreach (CompilerError e in results.Errors)
                    {
                        if (e.IsWarning) continue;
                        errs.AppendLine($"  {e.Line},{e.Column}: {e.ErrorNumber} {e.ErrorText}");
                    }
                    throw new Exception("compile error:\n" + errs +
                        "\n\n[DSH hint] 已知限制：CodeDom 环境同时引用 mscorlib 与 netstandard facade，" +
                        "System.IO.*/System.Convert/System.Enum/System.Array/System.Collections.Generic.List<T>/System.AppDomain " +
                        "等类型会 CS0433 不可用（勿尝试修改引用逻辑，已试过无解）。" +
                        "替代：数组用 new T[n]，传文件直接 return byte[]（桥接自动转 base64，结果带 \"@b64:\" 前缀），" +
                        "不要用局部函数（mcs 不支持）。");
                }

                var type = results.CompiledAssembly.GetType("__DshBridgeEval.Eval");
                var method = type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
                return method.Invoke(null, null);
            }
        }
    }

    public static class DshBridge
    {
        private const int Port = 6417;

        private static TcpListener listener;
        private static Thread acceptThread;
        private static volatile bool running;
        private static string cachedVersion = "";

        private static readonly object QueueLock = new object();
        private static readonly Queue<Command> CommandQueue = new Queue<Command>();

        private class Command
        {
            public string code;
            public string result;
            public string error;
            public readonly List<string> logs = new List<string>();
            public readonly ManualResetEvent Done = new ManualResetEvent(false);
        }

        [MenuItem("Tools/DSH Bridge/Start")]
        public static void Start()
        {
            if (running)
            {
                Debug.Log("[DshBridge] already running");
                return;
            }
            listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Start();
            running = true;
            cachedVersion = Application.unityVersion;
            EditorApplication.update -= ProcessQueue;
            EditorApplication.update += ProcessQueue;
            acceptThread = new Thread(AcceptLoop) { IsBackground = true };
            acceptThread.Start();
            Debug.Log($"[DshBridge] listening on http://127.0.0.1:{Port}/");
        }

        [MenuItem("Tools/DSH Bridge/Stop")]
        public static void Stop()
        {
            running = false;
            try { listener?.Stop(); } catch { /* already stopped */ }
            EditorApplication.update -= ProcessQueue;
            Debug.Log("[DshBridge] stopped");
        }

        public static bool IsRunning() => running;

        private static void AcceptLoop()
        {
            while (running)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
                }
                catch
                {
                    if (running) continue;
                    break;
                }
            }
        }

        // Runs on the Unity main thread (hooked to EditorApplication.update).
        private static void ProcessQueue()
        {
            Command cmd;
            lock (QueueLock) { cmd = CommandQueue.Count > 0 ? CommandQueue.Dequeue() : null; }
            if (cmd == null) return;

            Application.LogCallback onLog = (condition, stackTrace, type) =>
            {
                if (type == LogType.Log || type == LogType.Warning || type == LogType.Error)
                    cmd.logs.Add($"[{type}] {condition}");
            };
            try
            {
                Application.logMessageReceived += onLog;
                try
                {
                    var value = CSharpEval.Evaluate(cmd.code);
                    if (value is byte[] bytes)
                        cmd.result = "@b64:" + Convert.ToBase64String(bytes);
                    else
                        cmd.result = value == null ? "null" : value.ToString();
                }
                finally
                {
                    Application.logMessageReceived -= onLog;
                }
            }
            catch (Exception e)
            {
                cmd.error = e.ToString();
            }
            finally
            {
                cmd.Done.Set();
            }
        }

        private static void HandleClient(TcpClient client)
        {
            try
            {
                using (client)
                using (var stream = client.GetStream())
                {
                    stream.ReadTimeout = 10000;
                    var body = ReadRequest(stream, out var method, out var path);

                    if (method == "GET" && path == "/api/health")
                    {
                        WriteResponse(stream, 200,
                            "{\"ok\":true,\"unity\":\"" + cachedVersion + "\",\"bridge\":\"0.1.2\"}");
                        return;
                    }

                    if (method == "POST" && path == "/api/execute")
                    {
                        string code = "";
                        try
                        {
                            var req = JsonUtility.FromJson<ExecuteRequest>(body);
                            code = req != null ? req.code : "";
                        }
                        catch
                        {
                            code = "";
                        }
                        if (string.IsNullOrWhiteSpace(code))
                        {
                            WriteResponse(stream, 400, "{\"error\":\"empty code\"}");
                            return;
                        }

                        var cmd = new Command { code = code };
                        lock (QueueLock) CommandQueue.Enqueue(cmd);

                        if (cmd.Done.WaitOne(30000))
                        {
                            if (cmd.error != null)
                            {
                                WriteResponse(stream, 500, "{\"error\":" + Json.Escape(cmd.error) + "}");
                            }
                            else
                            {
                                var logsArr = new StringBuilder("[");
                                for (var i = 0; i < cmd.logs.Count; i++)
                                {
                                    if (i > 0) logsArr.Append(",");
                                    logsArr.Append(Json.Escape(cmd.logs[i]));
                                }
                                logsArr.Append("]");
                                WriteResponse(stream, 200,
                                    "{\"result\":" + Json.Escape(cmd.result) + ",\"logs\":" + logsArr + "}");
                            }
                        }
                        else
                        {
                            WriteResponse(stream, 500, "{\"error\":\"timed out after 30s\"}");
                        }
                        return;
                    }

                    WriteResponse(stream, 404, "{\"error\":\"not found\"}");
                }
            }
            catch
            {
                // Client disconnected mid-request, or response write failed. Ignore.
            }
        }

        private static string ReadRequest(NetworkStream stream, out string method, out string path)
        {
            method = "";
            path = "";
            var headerBytes = new MemoryStream();
            var state = 0; // 0..3 tracking "\r\n\r\n"
            int b;
            while ((b = stream.ReadByte()) != -1)
            {
                headerBytes.WriteByte((byte)b);
                if (b == '\r' && state == 0) state = 1;
                else if (b == '\n' && state == 1) state = 2;
                else if (b == '\r' && state == 2) state = 3;
                else if (b == '\n' && state == 3) break;
                else state = (b == '\r') ? 1 : 0;
            }

            var header = Encoding.UTF8.GetString(headerBytes.ToArray());
            var lines = header.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0) return "";
            var parts = lines[0].Split(' ');
            method = parts.Length > 0 ? parts[0] : "";
            path = parts.Length > 1 ? parts[1] : "";

            var contentLength = 0;
            foreach (var line in lines)
            {
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                {
                    int.TryParse(line.Substring("Content-Length:".Length).Trim(), out contentLength);
                }
            }

            var bodyBytes = new byte[contentLength];
            var read = 0;
            while (read < contentLength)
            {
                var n = stream.Read(bodyBytes, read, contentLength - read);
                if (n <= 0) break;
                read += n;
            }
            return Encoding.UTF8.GetString(bodyBytes, 0, read);
        }

        private static void WriteResponse(NetworkStream stream, int status, string json)
        {
            var statusText = status switch
            {
                200 => "OK",
                400 => "Bad Request",
                404 => "Not Found",
                500 => "Internal Server Error",
                _ => "Error",
            };
            var bodyBytes = Encoding.UTF8.GetBytes(json);
            var head = $"HTTP/1.1 {status} {statusText}\r\n" +
                       "Content-Type: application/json; charset=utf-8\r\n" +
                       $"Content-Length: {bodyBytes.Length}\r\n" +
                       "Connection: close\r\n\r\n";
            var headBytes = Encoding.UTF8.GetBytes(head);
            stream.Write(headBytes, 0, headBytes.Length);
            stream.Write(bodyBytes, 0, bodyBytes.Length);
            stream.Flush();
        }
    }

    // 自动重启：域重载（改脚本/装包/进出 Play Mode）后自动拉起 HTTP 服务，
    // 并在重载前主动 Stop 释放端口，避免 “Address already in use”。
    [InitializeOnLoad]
    public static class DshBridgeAutoStart
    {
        static DshBridgeAutoStart()
        {
            AssemblyReloadEvents.beforeAssemblyReload += () => DshBridge.Stop();
            EditorApplication.delayCall += TryStart;
            EditorApplication.update += Watchdog;
        }

        static void TryStart()
        {
            try
            {
                if (!DshBridge.IsRunning())
                    DshBridge.Start();
            }
            catch (System.Exception e)
            {
                Debug.LogWarning("[DshBridge] auto-start failed: " + e.Message);
            }
        }

        static float nextCheck;
        static void Watchdog()
        {
            if (Time.realtimeSinceStartup < nextCheck) return;
            nextCheck = Time.realtimeSinceStartup + 3f;
            TryStart();
        }
    }
}
