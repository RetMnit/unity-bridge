// Shared Unity Editor bridge. Existing asset GUIDs are preserved.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using UnityEngine.SceneManagement;
using Process = System.Diagnostics.Process;

namespace UnityBridge
{
    [Serializable] public sealed class BridgeRequest
    {
        public string id, code, operation;
        public int limit = 100, queueTimeoutMs = 30000, waitMs = 30000;
    }
    [Serializable] public sealed class JobView
    {
        public string id, state, operation, fingerprint, result = "", error = "";
        public string createdUtc, updatedUtc, instanceId;
        public string[] logs = new string[0];
        public bool executionMayHaveOccurred;
    }
    [Serializable] public sealed class HealthView
    {
        public bool ok = true, compiling, updating, playing, paused;
        public string unity, bridge = "0.4.0", protocol = "2", projectPath, projectName, instanceId, sampledUtc;
        public string compiler = "Unity Roslyn / C# 9";
        public int pid, port, queued, loadedSnippets;
        public string[] capabilities = { "jobs", "deduplication", "durable-status", "cancel-queued", "hierarchy", "logs", "state", "screenshot" };
    }
    internal sealed class Job
    {
        public BridgeRequest Request;
        public JobView View;
        public DateTime Deadline;
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim();
        public readonly List<string> Logs = new List<string>();
    }
    internal sealed class Compilation : IDisposable
    {
        public string Folder, Dll, Key, Dotnet, Compiler, Rsp;
        public Task<string> Work;
        private Process child;
        private bool disposed;
        public void Start()
        {
            Work = Task.Run(() =>
            {
                try
                {
                    using (var p = new Process())
                    {
                        p.StartInfo = new System.Diagnostics.ProcessStartInfo(Dotnet, "\"" + Compiler + "\" @\"" + Rsp + "\"")
                        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                          StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = Folder };
                        lock (this) { if (disposed) return "Compilation cancelled."; p.Start(); child = p; }
                        var stdout = p.StandardOutput.ReadToEndAsync();
                        var stderr = p.StandardError.ReadToEndAsync();
                        if (!p.WaitForExit(30000))
                        {
                            try { p.Kill(); } catch { }
                            p.WaitForExit();
                            return "Roslyn compilation exceeded 30 seconds; no snippet was executed.";
                        }
                        Task.WaitAll(stdout, stderr);
                        return p.ExitCode == 0 ? null : (stdout.Result + "\n" + stderr.Result).Trim();
                    }
                }
                catch (Exception e) { return e.Message; }
            });
        }
        public void Dispose()
        {
            lock (this) { disposed = true; try { if (child != null && !child.HasExited) child.Kill(); } catch { } }
            if (Work == null || Work.IsCompleted) Cleanup(); else Work.ContinueWith(_ => Cleanup());
        }
        private void Cleanup() { try { if (Directory.Exists(Folder)) Directory.Delete(Folder, true); } catch { } }
    }

    [InitializeOnLoad] public static class UnityBridgeServer
    {
        private const int MaxJobs = 128, MaxQueue = 32, MaxSnippets = 128, MaxBody = 1024 * 1024, MaxBinary = 8 * 1024 * 1024;
        private const string EnabledKey = "UnityBridge.Enabled";
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, Job> Jobs = new Dictionary<string, Job>();
        private static readonly Queue<Job> Queue = new Queue<Job>();
        private static readonly Dictionary<string, MethodInfo> Methods = new Dictionary<string, MethodInfo>();
        private static readonly Queue<string> ConsoleLogs = new Queue<string>();
        private static readonly SemaphoreSlim Connections = new SemaphoreSlim(16);
        private static TcpListener listener;
        private static volatile bool running;
        private static volatile string healthJson = "{\"ok\":false}";
        private static Job active;
        private static Compilation compilation;
        private static string root, journal, discoveryFile, instance, token;
        private static int port, pid;
        private static double nextWatchdog, nextHealth;

        static UnityBridgeServer()
        {
            root = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            journal = Path.Combine(root, "Library", "UnityBridge", "jobs");
            pid = Process.GetCurrentProcess().Id; instance = Guid.NewGuid().ToString("N");
            token = Environment.GetEnvironmentVariable("UNITY_BRIDGE_TOKEN");
            Application.logMessageReceivedThreaded += CaptureLog;
            AssemblyReloadEvents.beforeAssemblyReload += () => Shutdown("Domain reload interrupted the request.");
            EditorApplication.quitting += () => Shutdown("Editor exited before completion.");
            EditorApplication.update += Update;
            EditorApplication.delayCall += AutoStart;
        }
        [MenuItem("Tools/Unity Bridge/Start")] public static void Start()
        {
            SessionState.SetBool(EnabledKey, true);
            if (running) return;
            Directory.CreateDirectory(journal); RestoreJobs();
            int configured;
            var explicitPort = int.TryParse(Environment.GetEnvironmentVariable("UNITY_BRIDGE_PORT"), out configured);
            if (explicitPort && (configured < 1024 || configured > 65535)) throw new Exception("UNITY_BRIDGE_PORT must be 1024..65535.");
            for (var candidate = explicitPort ? configured : 6417; candidate <= (explicitPort ? configured : 6450); candidate++)
            {
                var attempt = new TcpListener(IPAddress.Loopback, candidate);
                try { attempt.Start(); listener = attempt; port = candidate; break; }
                catch (SocketException) { attempt.Stop(); if (explicitPort || candidate == 6450) throw; }
            }
            running = true; RefreshHealth();
            var discovery = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "UnityBridge", "editors");
            Directory.CreateDirectory(discovery); discoveryFile = Path.Combine(discovery, pid + ".json");
            AtomicWrite(discoveryFile, healthJson);
            var socket = listener;
            new Thread(() => AcceptLoop(socket)) { IsBackground = true, Name = "Unity Bridge HTTP" }.Start();
            Debug.Log("[Unity Bridge] Listening on http://127.0.0.1:" + port + " (" + root + ")");
        }
        [MenuItem("Tools/Unity Bridge/Stop")] public static void Stop() { SessionState.SetBool(EnabledKey, false); Shutdown("Bridge stopped."); }
        public static bool IsRunning() { return running; }
        [MenuItem("Tools/Unity Bridge/Reload Domain")] public static void ReloadDomain() { EditorUtility.RequestScriptReload(); }
        private static void AutoStart()
        {
            if (!SessionState.GetBool(EnabledKey, true) || running) return;
            try { Start(); } catch (Exception e) { Debug.LogWarning("[Unity Bridge] " + e.Message); }
        }
        private static void Shutdown(string reason)
        {
            running = false; try { listener?.Stop(); } catch { }
            lock (Gate)
            {
                foreach (var job in Jobs.Values.Where(j => !Terminal(j.View.state)).ToArray())
                {
                    job.View.executionMayHaveOccurred = job.View.state == "running";
                    Finish(job, job.View.executionMayHaveOccurred ? "interrupted" : "cancelled", reason);
                }
                Queue.Clear();
            }
            compilation?.Dispose(); compilation = null; active = null;
            try { if (discoveryFile != null) File.Delete(discoveryFile); } catch { }
        }
        private static void Update()
        {
            if (EditorApplication.timeSinceStartup >= nextWatchdog) { nextWatchdog = EditorApplication.timeSinceStartup + 5; AutoStart(); }
            if (!running) return;
            lock (Gate)
            {
                foreach (var job in Jobs.Values.Where(j => j.View.state == "queued" && DateTime.UtcNow > j.Deadline).ToArray())
                    Finish(job, "cancelled", "Queue deadline expired; command was not executed.");
            }
            var busy = EditorApplication.isCompiling || EditorApplication.isUpdating;
            if (active != null && compilation != null && compilation.Work.IsCompleted && !busy)
            {
                var job = active;
                var readyCompilation = compilation;
                if (!Terminal(job.View.state))
                {
                    var error = readyCompilation.Work.Result;
                    if (error != null) Finish(job, "failed", "compile error:\n" + error);
                    else try
                    {
                        var method = System.Reflection.Assembly.Load(File.ReadAllBytes(readyCompilation.Dll)).GetType("__UnityBridgeEval.Eval").GetMethod("Run");
                        Methods[readyCompilation.Key] = method; Execute(job, method);
                    }
                    catch (Exception e) { Finish(job, "failed", Unwrap(e).ToString()); }
                }
                readyCompilation.Dispose();
                if (ReferenceEquals(compilation, readyCompilation)) { compilation = null; active = null; }
            }
            if (active == null && !busy)
            {
                Job job = null;
                lock (Gate)
                {
                    while (Queue.Count > 0 && job == null)
                    {
                        var candidate = Queue.Dequeue();
                        if (Terminal(candidate.View.state)) continue;
                        if (DateTime.UtcNow > candidate.Deadline) { Finish(candidate, "cancelled", "Queue deadline expired; command was not executed."); continue; }
                        try { SetState(candidate, "compiling"); job = candidate; active = job; }
                        catch (Exception e) { Finish(candidate, "failed", "Cannot journal execution intent; command was not executed: " + e.Message); }
                    }
                }
                if (job != null)
                {
                    try
                    {
                        if (job.Request.operation != "eval") { Execute(job, null); active = null; }
                        else
                        {
                            var plan = PrepareCompilation(job.Request.code);
                            MethodInfo cached;
                            if (Methods.TryGetValue(plan.Key, out cached)) { plan.Dispose(); Execute(job, cached); active = null; }
                            else
                            {
                                if (Methods.Count >= MaxSnippets) { plan.Dispose(); throw new Exception("128 unique snippets loaded. Reload the domain to release assemblies; fixed operations remain available."); }
                                compilation = plan; compilation.Start();
                            }
                        }
                    }
                    catch (Exception e) { Finish(job, "failed", Unwrap(e).ToString()); active = null; compilation?.Dispose(); compilation = null; }
                }
            }
            if (EditorApplication.timeSinceStartup >= nextHealth) { nextHealth = EditorApplication.timeSinceStartup + 0.25; RefreshHealth(); }
        }
        private static Compilation PrepareCompilation(string code)
        {
            var folder = Path.Combine(root, "Library", "UnityBridge", "compile", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            var plan = new Compilation { Folder = folder, Dll = Path.Combine(folder, "snippet.dll") };
            try
            {
                var data = EditorApplication.applicationContentsPath;
                plan.Compiler = Path.Combine(data, "DotNetSdkRoslyn", "csc.dll");
                plan.Dotnet = Path.Combine(data, "NetCoreRuntime", Application.platform == RuntimePlatform.WindowsEditor ? "dotnet.exe" : "dotnet");
                if (!File.Exists(plan.Compiler) || !File.Exists(plan.Dotnet)) throw new Exception("Unity's bundled Roslyn or .NET host is missing. Repair the Editor installation; CodeDom fallback is disabled.");
                var source = Path.Combine(folder, "snippet.cs");
                File.WriteAllText(source, "using System; using System.Collections; using System.Collections.Generic; using System.Linq; using UnityEngine; using UnityEditor; using Object = UnityEngine.Object;\nnamespace __UnityBridgeEval { public static class Eval { public static object Run() {\n#line 1 \"snippet.cs\"\n" + code + "\n#line default\nreturn null; } } }", new UTF8Encoding(false));
                var builder = new AssemblyBuilder(plan.Dll, new[] { source })
                { flags = AssemblyBuilderFlags.EditorAssembly, referencesOptions = ReferencesOptions.UseEngineModules };
                var references = new HashSet<string>(builder.defaultReferences.Select(Path.GetFullPath), StringComparer.OrdinalIgnoreCase);
                // AssemblyBuilder defaults may omit Editor module DLLs on 2022 LTS.
                // Add Editor API modules, never runtime System/mscorlib assemblies.
                foreach (var module in Directory.GetFiles(Path.GetDirectoryName(typeof(EditorApplication).Assembly.Location), "UnityEditor*.dll"))
                    if (!references.Any(r => string.Equals(Path.GetFileName(r), Path.GetFileName(module), StringComparison.OrdinalIgnoreCase))) references.Add(module);
                foreach (var a in CompilationPipeline.GetAssemblies(AssembliesType.Editor)) if (File.Exists(a.outputPath)) references.Add(Path.GetFullPath(a.outputPath));
                var sorted = references.Where(File.Exists).OrderBy(p => p, StringComparer.Ordinal).ToArray();
                plan.Key = Hash(code + "\n" + string.Join("\n", sorted.Select(p => p + ":" + File.GetLastWriteTimeUtc(p).Ticks)));
                plan.Rsp = Path.Combine(folder, "compile.rsp");
                var flags = new List<string> { "-nologo", "-utf8output", "-preferreduilang:en-US", "-nowarn:0162", "-target:library", "-langversion:9.0", "-nostdlib+", "-optimize+", "-out:\"" + plan.Dll + "\"" };
                if (builder.defaultDefines.Length > 0) flags.Add("-define:" + string.Join(";", builder.defaultDefines));
                flags.AddRange(sorted.Select(p => "-reference:\"" + p + "\"")); flags.Add("\"" + source + "\"");
                File.WriteAllLines(plan.Rsp, flags, new UTF8Encoding(false)); return plan;
            }
            catch { plan.Dispose(); throw; }
        }
        private static void Execute(Job job, MethodInfo method)
        {
            lock (Gate) { job.View.executionMayHaveOccurred = true; SetState(job, "running"); } // Durable intent before invoking user code.
            try
            {
                object value = method != null ? method.Invoke(null, null) : Builtin(job.Request);
                if (Terminal(job.View.state)) return; // Shutdown/reload may have interrupted this invocation.
                if (value is Task) throw new Exception("Snippets must be synchronous. Returning Task does not await it; inspect asynchronous Editor work with separate commands.");
                if (value is byte[] bytes)
                {
                    if (bytes.Length > MaxBinary) throw new Exception("Binary result exceeds 8 MiB. Write the artifact to disk and return its path.");
                    lock (Gate) job.View.result = "@b64:" + Convert.ToBase64String(bytes);
                }
                else { var text = value == null ? "null" : value.ToString(); lock (Gate) job.View.result = text; }
                Finish(job, "succeeded", "");
            }
            catch (Exception e) { Finish(job, "failed", Unwrap(e).ToString()); }
        }
        private static object Builtin(BridgeRequest request)
        {
            var count = request.limit <= 0 ? 100 : Math.Min(request.limit, 1000);
            switch (request.operation)
            {
                case "state": RefreshHealth(); return healthJson;
                case "logs": lock (ConsoleLogs) return string.Join("\n", ConsoleLogs.Reverse().Take(count).Reverse());
                case "hierarchy":
                    var lines = new List<string>();
                    for (var i = 0; i < SceneManager.sceneCount && lines.Count < count; i++)
                    {
                        var scene = SceneManager.GetSceneAt(i); lines.Add("Scene: " + scene.name + " | " + scene.path + " | dirty=" + scene.isDirty);
                        foreach (var go in scene.GetRootGameObjects()) AddHierarchy(go.transform, "", lines, count);
                    }
                    return string.Join("\n", lines);
                case "screenshot":
                    if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null) throw new Exception("Screenshot requires graphics enabled.");
                    var view = SceneView.lastActiveSceneView;
                    if (view == null) throw new Exception("Open a Scene view before requesting a screenshot.");
                    var camera = view.camera; var previous = camera.targetTexture; var previousActive = RenderTexture.active;
                    var rt = RenderTexture.GetTemporary(1280, 720, 24); Texture2D tex = null;
                    try
                    {
                        camera.targetTexture = rt; camera.Render(); RenderTexture.active = rt;
                        tex = new Texture2D(1280, 720, TextureFormat.RGB24, false); tex.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0); tex.Apply(); return tex.EncodeToPNG();
                    }
                    finally { camera.targetTexture = previous; RenderTexture.active = previousActive; RenderTexture.ReleaseTemporary(rt); if (tex != null) UnityEngine.Object.DestroyImmediate(tex); }
                default: throw new Exception("Unknown operation: " + request.operation);
            }
        }
        private static void AddHierarchy(Transform t, string indent, List<string> lines, int max)
        {
            if (lines.Count >= max) return;
            lines.Add(indent + t.name + " | id=" + t.gameObject.GetInstanceID() + " | active=" + t.gameObject.activeSelf);
            foreach (Transform child in t) AddHierarchy(child, indent + "  ", lines, max);
        }
        private static void CaptureLog(string message, string stack, LogType type)
        {
            var line = "[" + type + "] " + message;
            if (line.Length > 8192) line = line.Substring(0, 8192) + " [truncated]";
            lock (ConsoleLogs) { ConsoleLogs.Enqueue(line); while (ConsoleLogs.Count > 500) ConsoleLogs.Dequeue(); }
            var current = active; // Never take Gate from a worker log callback.
            if (current != null && current.View.state == "running") lock (current.Logs) { if (current.Logs.Count < 200) current.Logs.Add(line); }
        }
        private static void RefreshHealth()
        {
            lock (Gate)
            healthJson = JsonUtility.ToJson(new HealthView { unity = Application.unityVersion, projectPath = root,
                projectName = Path.GetFileName(root), instanceId = instance, sampledUtc = DateTime.UtcNow.ToString("o"), pid = pid, port = port,
                compiling = EditorApplication.isCompiling, updating = EditorApplication.isUpdating,
                playing = EditorApplication.isPlaying, paused = EditorApplication.isPaused,
                queued = Jobs.Values.Count(j => j.View.state == "queued"), loadedSnippets = Methods.Count });
        }
        private static void SetState(Job job, string state) { lock (Gate) { job.View.state = state; job.View.updatedUtc = DateTime.UtcNow.ToString("o"); Persist(job); } }
        private static void Finish(Job job, string state, string error)
        {
            lock (Gate)
            {
            job.View.error = error; lock (job.Logs) job.View.logs = job.Logs.ToArray();
            try { SetState(job, state); }
            catch (Exception e) { job.View.error += "\nCould not persist final status: " + e.Message; }
            finally { job.Done.Set(); }
            }
        }
        private static bool Terminal(string state) { return state == "succeeded" || state == "failed" || state == "cancelled" || state == "interrupted"; }
        private static Exception Unwrap(Exception e) { return e is TargetInvocationException && e.InnerException != null ? e.InnerException : e; }
        private static string Hash(string text) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
        private static bool ValidId(string id) { return id != null && id.Length >= 1 && id.Length <= 80 && id.All(c => (char.IsLetterOrDigit(c) && c < 128) || c == '-' || c == '_'); }
        private static void AtomicWrite(string path, string text)
        {
            var temp = path + ".tmp"; File.WriteAllText(temp, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
        }
        private static void Persist(Job job) { AtomicWrite(Path.Combine(journal, job.View.id + ".json"), JsonUtility.ToJson(job.View)); }
        private static void RestoreJobs()
        {
            lock (Gate)
            {
                Jobs.Clear(); Queue.Clear();
                foreach (var file in Directory.GetFiles(journal, "*.json").OrderByDescending(File.GetLastWriteTimeUtc).Take(MaxJobs))
                {
                    try
                    {
                        var view = JsonUtility.FromJson<JobView>(File.ReadAllText(file)); if (!ValidId(view.id)) continue;
                        var job = new Job { View = view }; Jobs[view.id] = job;
                        if (!Terminal(view.state))
                        {
                            view.executionMayHaveOccurred = view.state == "running";
                            Finish(job, view.executionMayHaveOccurred ? "interrupted" : "cancelled", "Editor or domain restarted; command will not be replayed.");
                        }
                        else job.Done.Set();
                    }
                    catch (Exception e) { Debug.LogWarning("[Unity Bridge] Could not restore job: " + e.Message); }
                }
            }
        }
        private static void AcceptLoop(TcpListener socket)
        {
            while (running && ReferenceEquals(listener, socket))
            {
                TcpClient client; try { client = socket.AcceptTcpClient(); } catch { break; }
                if (!Connections.Wait(0)) { client.Close(); continue; }
                ThreadPool.QueueUserWorkItem(_ => { try { HandleClient(client); } finally { Connections.Release(); } });
            }
        }
        private static void HandleClient(TcpClient client)
        {
            using (client)
            using (var stream = client.GetStream())
            {
                stream.ReadTimeout = 5000; stream.WriteTimeout = 5000;
                try
                {
                    string method, path, body; Dictionary<string, string> headers;
                    ReadRequest(stream, out method, out path, out body, out headers);
                    string host;
                    if (!headers.TryGetValue("Host", out host) || !(host == "127.0.0.1:" + port || host == "localhost:" + port)) { Error(stream, 403, "Invalid Host header."); return; }
                    if (headers.ContainsKey("Origin")) { Error(stream, 403, "Browser-origin requests are unsupported."); return; }
                    string auth;
                    if (!string.IsNullOrEmpty(token) && (!headers.TryGetValue("Authorization", out auth) || auth != "Bearer " + token)) { Error(stream, 401, "Authentication required."); return; }
                    string expectedProject;
                    if (headers.TryGetValue("X-Unity-Bridge-Project", out expectedProject))
                    {
                        try { expectedProject = Path.GetFullPath(Encoding.UTF8.GetString(Convert.FromBase64String(expectedProject))).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
                        catch { Error(stream, 400, "Invalid project identity header."); return; }
                        var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
                        if (!string.Equals(expectedProject, root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), comparison)) { Error(stream, 409, "Project identity mismatch; command was not accepted."); return; }
                    }
                    if (method == "GET" && path == "/api/health") { Respond(stream, 200, healthJson); return; }
                    const string prefix = "/api/jobs/";
                    if (path.StartsWith(prefix, StringComparison.Ordinal) && (method == "GET" || method == "DELETE"))
                    {
                        string response;
                        lock (Gate)
                        {
                            Job job;
                            if (!Jobs.TryGetValue(path.Substring(prefix.Length), out job)) { Error(stream, 404, "Unknown job ID. Eviction does not prove it was never executed."); return; }
                            if (method == "DELETE")
                            {
                                if (job.View.state != "queued") { Error(stream, 409, "Only queued commands can be cancelled."); return; }
                                Finish(job, "cancelled", "Cancelled before execution.");
                            }
                            response = JsonUtility.ToJson(job.View);
                        }
                        Respond(stream, 200, response); return;
                    }
                    if (method != "POST" || (path != "/api/execute" && path != "/api/jobs")) { Error(stream, 404, "Unknown endpoint."); return; }
                    BridgeRequest request;
                    try { request = JsonUtility.FromJson<BridgeRequest>(body); } catch { Error(stream, 400, "Invalid JSON."); return; }
                    if (request == null) { Error(stream, 400, "Expected a JSON object."); return; }
                    request.operation = string.IsNullOrEmpty(request.operation) ? "eval" : request.operation;
                    if (!(new[] { "eval", "state", "logs", "hierarchy", "screenshot" }).Contains(request.operation)) { Error(stream, 400, "Unsupported operation."); return; }
                    if (request.operation == "eval" && string.IsNullOrWhiteSpace(request.code)) { Error(stream, 400, "empty code"); return; }
                    if (string.IsNullOrEmpty(request.id)) request.id = Guid.NewGuid().ToString("N");
                    if (!ValidId(request.id)) { Error(stream, 400, "ID must contain 1..80 ASCII letters, digits, '-' or '_'."); return; }
                    var fingerprint = Hash(request.operation + "\n" + request.code + "\n" + request.limit); Job selected;
                    lock (Gate)
                    {
                        if (!running) { Error(stream, 503, "Bridge stopping; no command accepted."); return; }
                        if (Jobs.TryGetValue(request.id, out selected))
                        {
                            if (selected.View.fingerprint != fingerprint) { Error(stream, 409, "ID belongs to a different request."); return; }
                        }
                        else
                        {
                            if (Jobs.Values.Count(j => !Terminal(j.View.state)) >= MaxQueue) { Error(stream, 429, "Command queue is full."); return; }
                            if (Jobs.Count >= MaxJobs)
                            {
                                var oldest = Jobs.Values.Where(j => Terminal(j.View.state)).OrderBy(j => j.View.updatedUtc).FirstOrDefault();
                                if (oldest != null) { Jobs.Remove(oldest.View.id); File.Delete(Path.Combine(journal, oldest.View.id + ".json")); }
                            }
                            var now = DateTime.UtcNow;
                            selected = new Job { Request = request, Deadline = now.AddMilliseconds(Math.Max(1000, Math.Min(request.queueTimeoutMs <= 0 ? 30000 : request.queueTimeoutMs, 300000))),
                                View = new JobView { id = request.id, state = "queued", operation = request.operation, fingerprint = fingerprint,
                                    instanceId = instance, createdUtc = now.ToString("o"), updatedUtc = now.ToString("o") } };
                            Persist(selected); Jobs.Add(request.id, selected); Queue.Enqueue(selected);
                        }
                    }
                    if (path == "/api/execute") selected.Done.Wait(Math.Max(0, Math.Min(request.waitMs <= 0 ? 30000 : request.waitMs, 30000)));
                    string payload; int status;
                    lock (Gate)
                    {
                        var pending = !Terminal(selected.View.state);
                        status = pending ? (path == "/api/execute" ? 500 : 202) : selected.View.state == "succeeded" ? 200 : 500;
                        var view = selected.View;
                        if (pending && path == "/api/execute")
                        {
                            view = JsonUtility.FromJson<JobView>(JsonUtility.ToJson(view));
                            view.error = "Command " + view.id + " is " + view.state + "; outcome unknown. Query /api/jobs/" + view.id + "; do not repeat the write.";
                        }
                        payload = JsonUtility.ToJson(view);
                    }
                    Respond(stream, status, payload);
                }
                catch (InvalidDataException e) { try { Error(stream, 400, e.Message); } catch { } }
                catch (IOException) { } // Disconnect does not cancel or replay a job.
                catch (Exception e) { try { Error(stream, 500, e.Message); } catch { } }
            }
        }
        private static void ReadRequest(NetworkStream stream, out string method, out string path, out string body, out Dictionary<string, string> headers)
        {
            var bytes = new List<byte>(); int matched = 0; var end = new byte[] { 13, 10, 13, 10 };
            while (matched < 4)
            {
                var b = stream.ReadByte(); if (b < 0) throw new InvalidDataException("Incomplete headers.");
                bytes.Add((byte)b); if (bytes.Count > 16384) throw new InvalidDataException("Headers exceed 16 KiB.");
                matched = b == end[matched] ? matched + 1 : b == 13 ? 1 : 0;
            }
            var lines = Encoding.ASCII.GetString(bytes.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
            var first = lines[0].Split(' ');
            if (first.Length != 3 || !first[2].StartsWith("HTTP/1.")) throw new InvalidDataException("Invalid request line.");
            method = first[0]; path = first[1]; headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var line in lines.Skip(1))
            {
                if (line.Length == 0) continue;
                var colon = line.IndexOf(':'); if (colon < 1) throw new InvalidDataException("Invalid header.");
                var key = line.Substring(0, colon).Trim(); if (headers.ContainsKey(key)) throw new InvalidDataException("Duplicate header.");
                headers[key] = line.Substring(colon + 1).Trim();
            }
            if (headers.ContainsKey("Transfer-Encoding")) throw new InvalidDataException("Chunked requests unsupported; send Content-Length.");
            int length = 0; string raw;
            if (headers.TryGetValue("Content-Length", out raw) && (!int.TryParse(raw, out length) || length < 0 || length > MaxBody)) throw new InvalidDataException("Invalid Content-Length; limit is 1 MiB.");
            var content = new byte[length]; var offset = 0;
            while (offset < length) { var n = stream.Read(content, offset, length - offset); if (n == 0) throw new InvalidDataException("Incomplete body."); offset += n; }
            body = new UTF8Encoding(false, true).GetString(content);
        }
        [Serializable] private sealed class ErrorView { public string error; }
        private static void Error(NetworkStream stream, int status, string error) { Respond(stream, status, JsonUtility.ToJson(new ErrorView { error = error })); }
        private static void Respond(NetworkStream stream, int status, string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            var header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " " + ((HttpStatusCode)status) + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
            stream.Write(header, 0, header.Length); stream.Write(bytes, 0, bytes.Length); stream.Flush();
        }
    }
}
