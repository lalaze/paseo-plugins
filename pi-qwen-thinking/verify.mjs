import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  "pi-cli": { type: "string" },
  "agent-dir": { type: "string", default: join(homedir(), ".pi", "agent") },
  "extension-dir": { type: "string" },
  "provider": { type: "string" },
  "report": { type: "string" },
  "baseline": { type: "boolean", default: false },
} });
if (!values["pi-cli"] || !values.provider) throw new Error("Specify --pi-cli and --provider");
const source = JSON.parse(await readFile(join(values["agent-dir"], "models.json"), "utf8"));
const provider = source.providers[values.provider];
const model = provider?.models?.find((m) => m.id === "qwen3.8-flash-next");
if (!model) throw new Error("Qwen3.8-Flash-Next model was not found");
const cases = [["off", false, undefined], ["minimal", true, "low"], ["low", true, "low"],
  ["medium", true, "medium"], ["high", true, "xhigh"], ["xhigh", true, "xhigh"]];
const scratch = await mkdtemp(join(tmpdir(), "pi-qwen-thinking-verify-"));
const agentDir = join(scratch, "agent");
const requests = [];
const children = new Set();
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    // Never store credentials, full prompts, or request headers.
    requests.push({ model: body.model, chat_template_kwargs: body.chat_template_kwargs,
      reasoning_effort: body.reasoning_effort });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "thinking-check", object: "chat.completion.chunk", created: 1, model: body.model };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});

function runPi(level) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, NO_PROXY: "*", no_proxy: "*" };
    for (const key of Object.keys(env)) if (key.toLowerCase().endsWith("_proxy") && !/^no_proxy$/i.test(key)) delete env[key];
    const child = spawn(process.execPath, [resolve(values["pi-cli"]), "--provider", values.provider,
      "--model", model.id, "--thinking", level, "--mode", "json", "--no-session", "--no-tools",
      "--no-skills", "--no-prompt-templates", "-p", "Reply OK."], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stderr = "", stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer); children.delete(child);
      if (code !== 0) reject(new Error(`Pi exited ${code}: ${stderr.slice(-1500)}`));
      else if (!stdout.includes('"OK"')) reject(new Error(`Pi did not receive the mock response: ${stderr.slice(-500)}`));
      else resolveRun();
    });
  });
}

try {
  await mkdir(agentDir, { recursive: true });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  // Keep the installed model's compatibility and capability settings, but isolate
  // all credentials, sessions, packages, and network traffic from the real agent.
  const fixtureModel = Object.fromEntries(["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat", "thinkingLevelMap"]
    .filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [values.provider]: {
    api: provider.api, compat: provider.compat, apiKey: "local-test-only",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [fixtureModel],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  if (values["extension-dir"]) {
    const dest = join(agentDir, "extensions", "qwen-thinking");
    await mkdir(dest, { recursive: true });
    for (const name of ["index.js", "package.json"]) await copyFile(join(values["extension-dir"], name), join(dest, name));
  }
  const results = [];
  for (const [level, enabled, effort] of cases) {
    const before = requests.length;
    await runPi(level);
    assert.equal(requests.length, before + 1, `one provider request for ${level}`);
    const request = requests.at(-1);
    assert.equal(request.chat_template_kwargs?.enable_thinking, enabled, `${level}: thinking toggle`);
    assert.equal(request.chat_template_kwargs?.preserve_thinking, true, `${level}: preserve existing behavior`);
    assert.equal(request.chat_template_kwargs?.reasoning_effort, values.baseline ? undefined : effort, `${level}: actual wire effort`);
    assert.equal(request.reasoning_effort, undefined, `${level}: no conflicting top-level effort`);
    results.push({ selected_level: level, ...request });
    console.log(JSON.stringify(results.at(-1)));
  }
  const report = { checkedAt: new Date().toISOString(), piCli: resolve(values["pi-cli"]),
    baseline: values.baseline, extensionDir: values["extension-dir"] || null, results };
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(values.baseline ? "BASELINE CONFIRMED: enabled levels omit reasoning_effort" : "PASS: all six thinking levels verified on real Pi HTTP requests");
} finally {
  for (const child of children) child.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
