import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppEvent } from '../shared.js';

const require = createRequire(import.meta.url);
const triples: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl'
};
export function bundledCodex(): string {
  const target = `${process.platform}-${process.arch}`;
  // Resolve relative to Codex as well: npm may nest its optional platform package.
  const cliRequire = createRequire(require.resolve('@openai/codex/package.json'));
  const pkg = cliRequire.resolve(`@openai/codex-${target}/package.json`);
  const native = path.join(path.dirname(pkg), 'vendor', triples[target] ?? '', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const unpacked = native.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  if (!existsSync(unpacked)) throw new Error('The bundled Codex binary is missing. Run npm ci without --omit=optional, or select a Codex executable in Settings.');
  return unpacked;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class CodexClient extends EventEmitter {
  toolHandler: ((params: { threadId: string; turnId: string; callId: string; tool: string; arguments: unknown }) => Promise<{ success: boolean; contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }> }>) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private buffer = '';
  private ready: Promise<void> | null = null;
  executable = '';
  get running(): boolean { return this.child !== null; }

  start(executable: string, cwd: string): Promise<void> {
    if (this.ready) return this.ready;
    this.executable = executable;
    this.ready = this.launch(executable, cwd).catch((error: unknown) => { this.close(); throw error; });
    return this.ready;
  }
  private async launch(executable: string, cwd: string): Promise<void> {
    const env = { ...process.env };
    // Explicitly use the user's cached Codex login, never an ambient API key.
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Drain stderr without writing auth URLs, transcripts, or credentials to disk.
    child.stderr.resume();
    child.stdin.on('error', (error: Error) => this.failed(error));
    child.on('error', (error: Error) => this.failed(new Error(`Could not launch Codex: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.failed(new Error(`Codex exited (${signal ?? code ?? 'unknown'}). Reconnect to try again.`));
    });
    await this.request('initialize', {
      clientInfo: { name: 'codex_voice_local', title: 'Codex Voice', version: '2.0.0' },
      capabilities: { experimentalApi: true }
    });
    this.write({ method: 'initialized', params: {} });
  }
  request(method: string, params: unknown, timeout = 45_000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out. Check your connection and reconnect.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  private write(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is disconnected.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) { this.failed(new Error('Codex sent an oversized protocol message.')); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method) {
        const p = this.pending.get(message.id);
        if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message ?? 'Codex rejected the request.'));
        else p.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        void this.answerServerRequest(message).catch(() => {});
      } else if (typeof message.method === 'string') {
        this.emit('notification', { method: message.method, params: message.params ?? {} } satisfies AppEvent);
      }
    }
  }
  private async answerServerRequest(message: any): Promise<void> {
    // This client does not implement tool permission dialogs. Fail closed.
    const method: string = message.method;
    let result: unknown;
    if (method === 'currentTime/read') result = { currentTimeAt: Math.floor(Date.now() / 1000) };
    else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') result = { decision: 'decline' };
    else if (method === 'execCommandApproval' || method === 'applyPatchApproval') result = { decision: 'denied' };
    else if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (method === 'mcpServer/elicitation/request') result = { action: 'decline', content: null };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'item/tool/call') {
      try { result = this.toolHandler ? await this.toolHandler(message.params) : { success: false, contentItems: [{ type: 'inputText', text: 'Tool execution is not supported.' }] }; }
      catch (error) { result = { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] }; }
    }
    else { this.write({ id: message.id, error: { code: -32601, message: 'This client does not support this server request.' } }); return; }
    this.write({ id: message.id, result });
    if (method !== 'currentTime/read' && method !== 'item/tool/call') this.emit('notification', {
      method: 'client/toolDeclined', params: { message: 'A computer action needed approval and was declined. Use the Codex app for that action.' }
    } satisfies AppEvent);
  }
  private failed(error: Error): void {
    this.close();
    this.emit('notification', { method: 'client/disconnected', params: { message: error.message } } satisfies AppEvent);
  }
  close(): void {
    const child = this.child;
    this.child = null; this.ready = null; this.buffer = '';
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex connection closed.')); }
    this.pending.clear();
    if (child) {
      child.stdin.end(); child.kill();
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      timer.unref();
    }
  }
}
