import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHost } from '../src/core/host';
import {
  createTools,
  executeToolCall,
  findTool,
  toToolDefinitions,
} from '../src/core/tools';
import type { ToolCall } from '../src/core/types';

function mockHost(overrides: Partial<WorkspaceHost> = {}): WorkspaceHost {
  return {
    readFile: vi.fn().mockResolvedValue('file contents'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([
      { name: 'src', type: 'dir' as const },
      { name: 'README.md', type: 'file' as const },
    ]),
    grep: vi.fn().mockResolvedValue('a.ts:1:match'),
    exec: vi.fn().mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 }),
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call_x', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('tool registry', () => {
  it('exposes the five MVP tools', () => {
    const names = createTools().map((t) => t.name);
    expect(names).toEqual(['read_file', 'list_dir', 'grep', 'write_file', 'run_command']);
  });

  it('marks only write_file and run_command as mutating', () => {
    const mutating = createTools()
      .filter((t) => t.mutating)
      .map((t) => t.name);
    expect(mutating).toEqual(['write_file', 'run_command']);
  });

  it('converts to OpenAI tool definitions', () => {
    const defs = toToolDefinitions(createTools());
    expect(defs[0]).toMatchObject({
      type: 'function',
      function: { name: 'read_file' },
    });
    expect(defs[0]!.function.parameters).toHaveProperty('properties');
  });

  it('finds tools by name', () => {
    const tools = createTools();
    expect(findTool(tools, 'grep')?.name).toBe('grep');
    expect(findTool(tools, 'nope')).toBeUndefined();
  });
});

describe('read_file', () => {
  it('returns file contents', async () => {
    const host = mockHost();
    const result = await executeToolCall(createTools(), call('read_file', { path: 'a.ts' }), host);
    expect(result).toBe('file contents');
    expect(host.readFile).toHaveBeenCalledWith('a.ts');
  });

  it('truncates very large files', async () => {
    const host = mockHost({ readFile: vi.fn().mockResolvedValue('x'.repeat(100_000)) });
    const result = await executeToolCall(createTools(), call('read_file', { path: 'big' }), host);
    expect(result.length).toBeLessThan(60_000);
    expect(result).toContain('[truncated]');
  });

  it('errors when path is missing', async () => {
    const result = await executeToolCall(createTools(), call('read_file', {}), mockHost());
    expect(result).toMatch(/^Error:.*path/i);
  });
});

describe('list_dir', () => {
  it('formats entries with trailing slash for dirs', async () => {
    const result = await executeToolCall(createTools(), call('list_dir', { path: '.' }), mockHost());
    expect(result).toBe('src/\nREADME.md');
  });

  it('defaults path to workspace root', async () => {
    const host = mockHost();
    await executeToolCall(createTools(), call('list_dir', {}), host);
    expect(host.listDir).toHaveBeenCalledWith('.');
  });

  it('reports empty directories', async () => {
    const host = mockHost({ listDir: vi.fn().mockResolvedValue([]) });
    const result = await executeToolCall(createTools(), call('list_dir', { path: 'empty' }), host);
    expect(result).toMatch(/empty/i);
  });
});

describe('grep', () => {
  it('passes pattern and include glob to the host', async () => {
    const host = mockHost();
    const result = await executeToolCall(
      createTools(),
      call('grep', { pattern: 'foo', include: '*.ts' }),
      host
    );
    expect(result).toBe('a.ts:1:match');
    expect(host.grep).toHaveBeenCalledWith('foo', '*.ts');
  });

  it('reports no matches', async () => {
    const host = mockHost({ grep: vi.fn().mockResolvedValue('') });
    const result = await executeToolCall(createTools(), call('grep', { pattern: 'zzz' }), host);
    expect(result).toMatch(/no matches/i);
  });
});

describe('write_file', () => {
  it('writes content and confirms', async () => {
    const host = mockHost();
    const result = await executeToolCall(
      createTools(),
      call('write_file', { path: 'out.ts', content: 'hello' }),
      host
    );
    expect(host.writeFile).toHaveBeenCalledWith('out.ts', 'hello');
    expect(result).toMatch(/out\.ts/);
  });

  it('errors when content is missing', async () => {
    const host = mockHost();
    const result = await executeToolCall(createTools(), call('write_file', { path: 'x' }), host);
    expect(result).toMatch(/^Error:/);
    expect(host.writeFile).not.toHaveBeenCalled();
  });
});

describe('run_command', () => {
  it('returns stdout, stderr and exit code', async () => {
    const host = mockHost({
      exec: vi.fn().mockResolvedValue({ stdout: 'hi', stderr: 'warn', exitCode: 2 }),
    });
    const result = await executeToolCall(createTools(), call('run_command', { command: 'ls' }), host);
    expect(result).toContain('hi');
    expect(result).toContain('warn');
    expect(result).toContain('exit code: 2');
  });

  it('uses a default timeout', async () => {
    const host = mockHost();
    await executeToolCall(createTools(), call('run_command', { command: 'ls' }), host);
    expect(host.exec).toHaveBeenCalledWith('ls', expect.any(Number));
  });
});

describe('executeToolCall error handling', () => {
  it('returns an error string for unknown tools', async () => {
    const result = await executeToolCall(createTools(), call('bogus', {}), mockHost());
    expect(result).toMatch(/^Error:.*unknown tool/i);
  });

  it('returns an error string for malformed JSON arguments', async () => {
    const bad: ToolCall = {
      id: 'c',
      type: 'function',
      function: { name: 'read_file', arguments: '{not json' },
    };
    const result = await executeToolCall(createTools(), bad, mockHost());
    expect(result).toMatch(/^Error:.*arguments/i);
  });

  it('treats empty arguments as an empty object', async () => {
    const noArgs: ToolCall = {
      id: 'c',
      type: 'function',
      function: { name: 'list_dir', arguments: '' },
    };
    const host = mockHost();
    const result = await executeToolCall(createTools(), noArgs, host);
    expect(result).toBe('src/\nREADME.md');
  });

  it('converts host exceptions into error strings', async () => {
    const host = mockHost({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT: missing')) });
    const result = await executeToolCall(createTools(), call('read_file', { path: 'x' }), host);
    expect(result).toMatch(/^Error:.*ENOENT/);
  });
});
