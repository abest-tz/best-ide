/**
 * Live closed-loop test of the agent core against a running LM Studio server.
 *
 * Usage:
 *   npm run test:live
 *
 * Optional env: BASE_URL (default http://localhost:1234/v1), MODEL, LM_API_TOKEN.
 * Exits 0 with a skip message when the local server is unreachable (so CI is not blocked).
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent } from '../src/core/agent';
import { OpenAIClient } from '../src/core/client';
import type { DirEntry, ExecResult, WorkspaceHost } from '../src/core/host';

class NodeWorkspaceHost implements WorkspaceHost {
  constructor(private readonly root: string) {}

  private resolve(relativePath: string): string {
    const absolute = path.resolve(this.root, relativePath);
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      throw new Error(`path "${relativePath}" is outside the workspace`);
    }
    return absolute;
  }

  async readFile(p: string): Promise<string> {
    return readFile(this.resolve(p), 'utf-8');
  }

  async writeFile(p: string, content: string): Promise<void> {
    await writeFile(this.resolve(p), content, 'utf-8');
  }

  async listDir(p: string): Promise<DirEntry[]> {
    const names = await readdir(this.resolve(p));
    const entries: DirEntry[] = [];
    for (const name of names) {
      const s = await stat(path.join(this.resolve(p), name));
      entries.push({ name, type: s.isDirectory() ? 'dir' : 'file' });
    }
    return entries;
  }

  async grep(): Promise<string> {
    return '';
  }

  async exec(): Promise<ExecResult> {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env['BASE_URL'] ?? 'http://localhost:1234/v1';
  const apiKey = process.env['LM_API_TOKEN'];
  const client = new OpenAIClient({ baseUrl, ...(apiKey ? { apiKey } : {}) });

  let models;
  try {
    models = await client.listModels();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`Skipping live e2e: model server unreachable at ${baseUrl} (${reason}).`);
    return;
  }

  console.log('models:', models.map((m) => m.id).join(', '));
  const model =
    process.env['MODEL'] ?? models.find((m) => !m.id.includes('embed'))?.id ?? models[0]?.id;
  if (!model) {
    console.log('Skipping live e2e: no models available.');
    return;
  }
  console.log('using model:', model);

  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'best-ide-live-'));
  console.log('sandbox workspace:', workspaceDir);

  const agent = new Agent({
    client,
    host: new NodeWorkspaceHost(workspaceDir),
    model,
    temperature: 0.2,
    maxSteps: 10,
    autoApprove: true, // sandbox temp dir; nothing of value can be harmed
  });

  await agent.run(
    'Create a file named greeting.txt containing exactly this single line: Hello from LM Studio',
    {
      onAssistantText: (t) => process.stdout.write(t),
      onToolCall: (call, mutating) =>
        console.log(`\n[tool call] ${call.function.name}(${call.function.arguments}) mutating=${mutating}`),
      onToolResult: (id, result) => console.log(`[tool result ${id}] ${result.slice(0, 200)}`),
      requestApproval: async () => true,
      onNotice: (n) => console.log(`\n[notice] ${n}`),
    }
  );

  console.log('\n--- verification ---');
  const content = await readFile(path.join(workspaceDir, 'greeting.txt'), 'utf-8').catch(
    () => null
  );
  if (content === null) {
    console.log('FAIL: greeting.txt was not created');
    process.exitCode = 1;
  } else {
    console.log('greeting.txt contents:', JSON.stringify(content));
    console.log(content.trim() === 'Hello from LM Studio' ? 'PASS' : 'PARTIAL: file created but content differs');
  }
  await rm(workspaceDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('live e2e failed:', error);
  process.exitCode = 1;
});
