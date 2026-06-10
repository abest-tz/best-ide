import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/core/agent';
import { OpenAIClient } from '../src/core/client';
import type { DirEntry, ExecResult, WorkspaceHost } from '../src/core/host';

/** Minimal node-fs WorkspaceHost for end-to-end testing without VS Code. */
class NodeWorkspaceHost implements WorkspaceHost {
  constructor(private readonly root: string) {}

  private resolve(relativePath: string): string {
    const absolute = path.resolve(this.root, relativePath);
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      throw new Error(`path "${relativePath}" is outside the workspace`);
    }
    return absolute;
  }

  async readFile(relativePath: string): Promise<string> {
    return readFile(this.resolve(relativePath), 'utf-8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    await writeFile(this.resolve(relativePath), content, 'utf-8');
  }

  async listDir(relativePath: string): Promise<DirEntry[]> {
    const names = await readdir(this.resolve(relativePath));
    const entries: DirEntry[] = [];
    for (const name of names) {
      const s = await stat(path.join(this.resolve(relativePath), name));
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

function sse(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * Stub OpenAI-compatible server: turn 1 streams a write_file tool call split
 * across deltas (like LM Studio does), turn 2 streams a text answer.
 */
function createStubServer(): { server: Server; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) {
        res.end(
          sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_w',
                        type: 'function',
                        function: { name: 'write_file', arguments: '{"path":"hello.txt",' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"content":"hi from agent"}' } }],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ])
        );
      } else {
        res.end(
          sse([
            { choices: [{ delta: { content: 'File written.' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ])
        );
      }
    });
  });
  return { server, requests };
}

describe('end-to-end agent loop over real HTTP', () => {
  let server: Server;
  let requests: Array<Record<string, unknown>>;
  let baseUrl: string;
  let workspaceDir: string;

  beforeAll(async () => {
    ({ server, requests } = createStubServer());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('no server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'best-ide-e2e-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('lists models, streams a tool call, gets approval, writes the file, and finishes', async () => {
    const client = new OpenAIClient({ baseUrl });
    expect(await client.listModels()).toEqual([{ id: 'stub-model' }]);

    const host = new NodeWorkspaceHost(workspaceDir);
    const agent = new Agent({ client, host, model: 'stub-model', temperature: 0 });

    const streamed: string[] = [];
    const requestApproval = vi.fn().mockResolvedValue(true);
    await agent.run('create hello.txt', {
      onAssistantText: (t) => streamed.push(t),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      requestApproval,
      onNotice: vi.fn(),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(await readFile(path.join(workspaceDir, 'hello.txt'), 'utf-8')).toBe('hi from agent');
    expect(streamed.join('')).toBe('File written.');

    // Second request must carry the assistant tool_calls turn and the tool result.
    const second = requests[1] as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});
