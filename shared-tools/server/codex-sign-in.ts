import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { McpConfig } from '../shared/rpc';
import { hasAuthHeader } from '../shared/form';
import { parseCallback, type FlowStatus } from './oauth';

export interface StartedSignIn {
  authorizationUrl: string;
  redirectUri: string;
  listening: boolean;
  via?: 'codex';
  reused?: boolean;
  source?: string | null;
}

type Launch = (args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
interface Flow {
  child: ChildProcessWithoutNullStreams;
  status: FlowStatus;
  authorizationUrl: string | null;
  submitted: boolean;
  completion: Promise<void>;
  cancel(): void;
}

/** Delegate OAuth to the real CLI, keeping the browser step in the Paseo app. */
export class CodexSignIns {
  private flows = new Map<string, Flow>();

  constructor(
    private readonly home: string,
    private readonly authorized: (name: string, config: McpConfig) => Promise<void>,
    private readonly launch: Launch = (args, env) => spawn('codex', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }),
    private readonly ttl = 15 * 60_000,
  ) {}

  async start(name: string, config: McpConfig): Promise<StartedSignIn> {
    if (config.type !== 'http' || hasAuthHeader(config)) throw new Error('Codex OAuth needs an HTTP MCP server without an Authorization header.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error('Invalid MCP server name.');
    this.cancel(name);
    // The temporary table overrides only this invocation; config.toml is never edited.
    const headers = Object.entries(config.headers ?? {}).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ');
    const table = `{ url = ${JSON.stringify(config.url)}${headers ? `, http_headers = { ${headers} }` : ''} }`;
    const args = ['-c', `mcp_servers.${name}=${table}`, '-c', 'mcp_oauth_credentials_store="file"', 'mcp', 'login', name, '--no-browser'];
    const child = this.launch(args, { ...process.env, CODEX_HOME: join(this.home, '.codex') });
    let resolveStart!: (value: StartedSignIn) => void;
    let rejectStart!: (error: Error) => void;
    const started = new Promise<StartedSignIn>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    // Completion may fail before a caller submits a callback or polls for status.
    void completion.catch(() => undefined);
    const output = { stdout: '', stderr: '' };
    let settled = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      force.unref();
    };
    const fail = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(startTimeout);
      const error = new Error(text);
      flow.status = { status: 'failed', error: text };
      rejectStart(error);
      rejectCompletion(error);
      stopChild();
    };
    const timeout = setTimeout(() => fail('Codex authorization timed out. / Codex 授权已超时，请重试。'), this.ttl);
    timeout.unref();
    const startTimeout = setTimeout(() => fail('Codex did not produce an authorization link. Check its MCP login support and network connection. / Codex 未返回授权链接，请检查版本和网络。'), Math.min(45_000, this.ttl));
    startTimeout.unref();
    const flow: Flow = {
      child, status: { status: 'pending' }, authorizationUrl: null, submitted: false, completion,
      cancel: () => {
        if (cleanup) clearTimeout(cleanup);
        fail('Codex authorization cancelled. / Codex 授权已取消。');
      },
    };
    this.flows.set(name, flow);
    child.stdin.on('error', () => fail('Could not submit the callback to Codex. / 无法将授权回调提交给 Codex。'));
    const receive = (stream: 'stdout' | 'stderr', data: Buffer) => {
      if (settled || flow.authorizationUrl) return;
      output[stream] = (output[stream] + data.toString()).slice(-65_536);
      // CLI versions may write the link or prompt to either stdout or stderr.
      for (const match of output[stream].matchAll(/https?:\/\/[^\s]+(?=\s)/g)) {
        let url: URL;
        try { url = new URL(match[0]); } catch { continue; }
        const redirect = url.searchParams.get('redirect_uri');
        if (url.searchParams.get('response_type') !== 'code' || !url.searchParams.has('state') || !url.searchParams.has('code_challenge') || !redirect) continue;
        try { new URL(redirect); } catch { continue; }
        flow.authorizationUrl = url.toString();
        clearTimeout(startTimeout);
        // --no-browser accepts a pasted callback instead of requiring a local listener.
        resolveStart({ authorizationUrl: url.toString(), redirectUri: redirect, listening: false, via: 'codex' });
        output.stdout = output.stderr = ''; // Do not retain CLI output or log OAuth links/codes.
        break;
      }
    };
    child.stdout.on('data', (data: Buffer) => receive('stdout', data));
    child.stderr.on('data', (data: Buffer) => receive('stderr', data));
    child.on('error', () => fail('Could not start Codex. Install a CLI with "mcp login --no-browser" support and make it available on the daemon PATH. / 无法启动 Codex，请安装支持 mcp login --no-browser 的 CLI，并确保主机 PATH 可找到它。'));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { fail(`Codex MCP authorization failed (exit ${code ?? 'signal'}). / Codex MCP 授权失败，请检查 CLI 版本或重试。`); return; }
      void this.authorized(name, config).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(startTimeout);
        flow.status = { status: 'done' };
        resolveCompletion();
        resolveStart({ authorizationUrl: '', redirectUri: '', listening: false, via: 'codex', reused: true, source: 'Codex' });
        cleanup = setTimeout(() => { if (this.flows.get(name) === flow) this.flows.delete(name); }, 60_000);
        cleanup.unref();
      }, () => fail('Codex finished, but the new MCP credential could not be reused. / Codex 已完成登录，但新 MCP 凭据无法复用，请重试。'));
    });
    return started;
  }

  status(name: string): FlowStatus | null { return this.flows.get(name)?.status ?? null; }

  async finish(name: string, callback: string): Promise<void> {
    const flow = this.flows.get(name);
    if (!flow || !flow.authorizationUrl) throw new Error('Start the Codex authorization first.');
    if (flow.status.status === 'done') return;
    if (flow.status.status === 'failed') throw new Error(flow.status.error);
    if (flow.submitted) return flow.completion;
    const text = callback.trim();
    if (/[\r\n]/.test(text)) throw new Error('Paste one complete callback URL.');
    const { state } = parseCallback(text);
    const authorization = new URL(flow.authorizationUrl);
    if (state !== authorization.searchParams.get('state')) throw new Error('This address belongs to another authorization. / 此地址不属于本次授权。');
    const pasted = new URL(text);
    const expected = new URL(authorization.searchParams.get('redirect_uri')!);
    if (pasted.origin !== expected.origin || pasted.pathname !== expected.pathname || pasted.hash || pasted.username || pasted.password) throw new Error('Paste the callback URL for this authorization.');
    flow.submitted = true;
    flow.child.stdin.end(`${text}\n`);
    return flow.completion;
  }

  cancel(name: string): void {
    this.flows.get(name)?.cancel();
    this.flows.delete(name);
  }

  stop(): void { for (const name of this.flows.keys()) this.cancel(name); }
}
