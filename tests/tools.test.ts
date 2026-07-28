import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceHost } from '../src/core/host';
import {
  createTools,
  executeToolCall,
  filterToolsForHost,
  findTool,
  prepareToolCall,
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
    semanticSearch: vi
      .fn()
      .mockResolvedValue('src/a.ts:1-12 (score 0.920)\nfunction searchWorkspace() { ... }'),
    listMcpTools: vi
      .fn()
      .mockResolvedValue('github.list_issues (read-only)\nList GitHub issues for a repository'),
    callMcpTool: vi.fn().mockResolvedValue('MCP tool call completed'),
    exec: vi.fn().mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 }),
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call_x', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

interface ParsedToolError {
  code: string;
  tool: string;
  message: string;
  retryable: boolean;
  details?: string[];
  attempts?: number;
  maxAttempts?: number;
}

function parseToolError(result: string): ParsedToolError {
  expect(result).toMatch(/^Error:/);
  return JSON.parse(result.slice('Error:'.length).trim()) as ParsedToolError;
}

describe('tool registry', () => {
  it('exposes the available tools', () => {
    const names = createTools().map((t) => t.name);
    expect(names).toEqual([
      'read_file',
      'list_dir',
      'grep',
      'semantic_search',
      'get_diagnostics',
      'get_symbols',
      'git_status',
      'git_diff',
      'mcp_list_tools',
      'mcp_call_tool',
      'write_file',
      'search_replace',
      'run_command',
    ]);
  });

  it('marks write_file, search_replace, mcp_call_tool, and run_command as mutating', () => {
    const mutating = createTools()
      .filter((t) => t.mutating)
      .map((t) => t.name);
    expect(mutating).toEqual(['mcp_call_tool', 'write_file', 'search_replace', 'run_command']);
  });

  it('exposes only read-only tools in ask mode', () => {
    const names = createTools('ask').map((t) => t.name);
    expect(names).toEqual([
      'read_file',
      'list_dir',
      'grep',
      'semantic_search',
      'get_diagnostics',
      'get_symbols',
      'git_status',
      'git_diff',
      'mcp_list_tools',
    ]);
  });

  it('exposes full tool access in composer mode', () => {
    const names = createTools('composer').map((t) => t.name);
    expect(names).toEqual(createTools('agent').map((tool) => tool.name));
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

  it('returns unknown tool errors for mutating calls in ask mode', async () => {
    const result = await executeToolCall(
      createTools('ask'),
      call('write_file', { path: 'out.ts', content: 'hello' }),
      mockHost()
    );
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'unknown_tool',
      tool: 'write_file',
      retryable: true,
    });
    expect(error.message).toMatch(/unknown tool "write_file"/i);
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
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'invalid_tool_arguments',
      tool: 'read_file',
      retryable: true,
    });
    expect(error.details).toContain('missing required argument "path"');
  });

  it('retries transient read-only failures once', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValue('recovered');
    const host = mockHost({ readFile });
    const result = await executeToolCall(createTools(), call('read_file', { path: 'a.ts' }), host);
    expect(result).toBe('recovered');
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('returns structured retry metadata when transient retries are exhausted', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('temporary timeout while reading file'));
    const result = await executeToolCall(
      createTools(),
      call('read_file', { path: 'a.ts' }),
      mockHost({ readFile })
    );
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'read_file',
      retryable: true,
      attempts: 2,
      maxAttempts: 2,
    });
    expect(readFile).toHaveBeenCalledTimes(2);
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

describe('semantic_search', () => {
  it('delegates to the host when supported', async () => {
    const host = mockHost();
    const result = await executeToolCall(
      createTools(),
      call('semantic_search', { query: 'workspace symbols', include: '*.ts', limit: 7 }),
      host
    );
    expect(result).toContain('score');
    expect(host.semanticSearch).toHaveBeenCalledWith('workspace symbols', '*.ts', 7);
  });

  it('bounds limit to the supported range', async () => {
    const host = mockHost();
    await executeToolCall(createTools(), call('semantic_search', { query: 'agent', limit: 99 }), host);
    expect(host.semanticSearch).toHaveBeenCalledWith('agent', undefined, 20);
  });

  it('returns an error when the host does not support semantic search', async () => {
    const result = await executeToolCall(
      createTools(),
      call('semantic_search', { query: 'agent loop' }),
      mockHost({ semanticSearch: undefined })
    );
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'semantic_search',
    });
    expect(error.message).toMatch(/not supported/i);
  });
});

describe('get_diagnostics', () => {
  it('delegates to the host when supported', async () => {
    const host = mockHost({ getDiagnostics: vi.fn().mockResolvedValue('a.ts:1:error:oops') });
    const result = await executeToolCall(createTools(), call('get_diagnostics', { path: 'a.ts' }), host);
    expect(result).toContain('a.ts:1:error');
    expect(host.getDiagnostics).toHaveBeenCalledWith('a.ts');
  });

  it('returns an error when the host does not support diagnostics', async () => {
    const result = await executeToolCall(createTools(), call('get_diagnostics', {}), mockHost());
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'get_diagnostics',
    });
    expect(error.message).toMatch(/not supported/i);
  });
});

describe('get_symbols', () => {
  it('delegates to the host when supported', async () => {
    const host = mockHost({ getSymbols: vi.fn().mockResolvedValue('src/a.ts:10:Function:run') });
    const result = await executeToolCall(
      createTools(),
      call('get_symbols', { query: 'run', path: 'src/a.ts' }),
      host
    );
    expect(result).toContain('Function:run');
    expect(host.getSymbols).toHaveBeenCalledWith('run', 'src/a.ts');
  });
});

describe('git tools', () => {
  it('uses git status command', async () => {
    const host = mockHost({ exec: vi.fn().mockResolvedValue({ stdout: '## main', stderr: '', exitCode: 0 }) });
    const result = await executeToolCall(createTools(), call('git_status', {}), host);
    expect(result).toContain('## main');
    expect(host.exec).toHaveBeenCalledWith('git status --short --branch', expect.any(Number));
  });

  it('uses staged git diff and optional path', async () => {
    const host = mockHost({
      exec: vi.fn().mockResolvedValue({ stdout: 'diff --git a/x b/x', stderr: '', exitCode: 0 }),
    });
    const result = await executeToolCall(
      createTools(),
      call('git_diff', { staged: true, path: 'src/x.ts' }),
      host
    );
    expect(result).toContain('diff --git');
    expect(host.exec).toHaveBeenCalledWith('git diff --staged -- "src/x.ts"', expect.any(Number));
  });
});

describe('mcp tools', () => {
  it('lists available MCP tools', async () => {
    const host = mockHost();
    const result = await executeToolCall(
      createTools(),
      call('mcp_list_tools', { server: 'github' }),
      host
    );
    expect(result).toContain('github.list_issues');
    expect(host.listMcpTools).toHaveBeenCalledWith('github');
  });

  it('calls an MCP tool with object arguments', async () => {
    const host = mockHost();
    const result = await executeToolCall(
      createTools(),
      call('mcp_call_tool', { server: 'github', tool: 'list_issues', arguments: { owner: 'acme' } }),
      host
    );
    expect(result).toContain('MCP tool call completed');
    expect(host.callMcpTool).toHaveBeenCalledWith('github', 'list_issues', { owner: 'acme' });
  });

  it('errors when MCP is not supported by the host', async () => {
    const result = await executeToolCall(
      createTools(),
      call('mcp_list_tools', {}),
      mockHost({ listMcpTools: undefined })
    );
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'mcp_list_tools',
    });
    expect(error.message).toMatch(/not supported/i);
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

describe('search_replace', () => {
  it('replaces one match by default', async () => {
    const host = mockHost({ readFile: vi.fn().mockResolvedValue('hello world') });
    const result = await executeToolCall(
      createTools(),
      call('search_replace', { path: 'a.txt', search: 'world', replace: 'team' }),
      host
    );
    expect(host.writeFile).toHaveBeenCalledWith('a.txt', 'hello team');
    expect(result).toMatch(/replaced 1 occurrence/i);
  });

  it('requires replaceAll for ambiguous matches', async () => {
    const host = mockHost({ readFile: vi.fn().mockResolvedValue('a\na') });
    const result = await executeToolCall(
      createTools(),
      call('search_replace', { path: 'a.txt', search: 'a', replace: 'b' }),
      host
    );
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'search_replace',
      retryable: false,
    });
    expect(error.message).toMatch(/replaceAll/i);
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('can replace all matches when replaceAll is true', async () => {
    const host = mockHost({ readFile: vi.fn().mockResolvedValue('a\na') });
    const result = await executeToolCall(
      createTools(),
      call('search_replace', { path: 'a.txt', search: 'a', replace: 'b', replaceAll: true }),
      host
    );
    expect(host.writeFile).toHaveBeenCalledWith('a.txt', 'b\nb');
    expect(result).toMatch(/replaced 2 occurrences/i);
  });
});

describe('run_command', () => {
  it('returns stdout, stderr and exit code', async () => {
    const host = mockHost({
      exec: vi.fn().mockResolvedValue({ stdout: 'hi', stderr: 'warn', exitCode: 2 }),
    });
    const result = await executeToolCall(createTools(), call('run_command', { command: 'ls' }), host);
    expect(result).toContain('stdout:\nhi');
    expect(result).toContain('stderr:\nwarn');
    expect(result).toContain('exit code: 2');
  });

  it('always returns explicit stdout and stderr sections', async () => {
    const host = mockHost({
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const result = await executeToolCall(createTools(), call('run_command', { command: 'ls' }), host);
    expect(result).toContain('stdout:\n(empty)');
    expect(result).toContain('stderr:\n(empty)');
  });

  it('prefers runCommand when the host provides it', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: 'integrated', stderr: '', exitCode: 0 });
    const host = mockHost({ runCommand });
    await executeToolCall(createTools(), call('run_command', { command: 'pwd' }), host);
    expect(runCommand).toHaveBeenCalledWith('pwd', undefined);
    expect(host.exec).not.toHaveBeenCalled();
  });

  it('passes timeout_ms overrides to the host', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: 'integrated', stderr: '', exitCode: 0 });
    const host = mockHost({ runCommand });
    await executeToolCall(
      createTools(),
      call('run_command', { command: 'pwd', timeout_ms: 2_500 }),
      host
    );
    expect(runCommand).toHaveBeenCalledWith('pwd', 2_500);
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
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'unknown_tool',
      tool: 'bogus',
      retryable: true,
    });
  });

  it('returns an error string for malformed JSON arguments', async () => {
    const bad: ToolCall = {
      id: 'c',
      type: 'function',
      function: { name: 'read_file', arguments: '{not json' },
    };
    const result = await executeToolCall(createTools(), bad, mockHost());
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'invalid_tool_arguments',
      tool: 'read_file',
      retryable: true,
    });
    expect(error.message).toMatch(/arguments/i);
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
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'tool_execution_failed',
      tool: 'read_file',
      retryable: false,
      attempts: 1,
      maxAttempts: 2,
    });
    expect(error.message).toMatch(/ENOENT/);
  });

  it('validates tool argument types from the schema', async () => {
    const host = mockHost();
    const result = await executeToolCall(createTools(), call('run_command', { command: 123 }), host);
    const error = parseToolError(result);
    expect(error).toMatchObject({
      code: 'invalid_tool_arguments',
      tool: 'run_command',
      retryable: true,
    });
    expect(error.details?.join('\n')).toMatch(/argument "command" must be string/i);
    expect(host.exec).not.toHaveBeenCalled();
  });

  it('rejects null and array JSON tool arguments', async () => {
    for (const raw of ['null', '[1,2]']) {
      const bad: ToolCall = {
        id: 'c',
        type: 'function',
        function: { name: 'list_dir', arguments: raw },
      };
      const result = await executeToolCall(createTools(), bad, mockHost());
      const error = parseToolError(result);
      expect(error).toMatchObject({
        code: 'invalid_tool_arguments',
        tool: 'list_dir',
        retryable: true,
      });
    }
  });

  it('omits available-tools details when the registry is empty', () => {
    const prepared = prepareToolCall([], call('read_file', { path: 'a.ts' }));
    expect(prepared.ok).toBe(false);
    if (prepared.ok) {
      return;
    }
    expect(prepared.error).toMatchObject({
      code: 'unknown_tool',
      tool: 'read_file',
      retryable: true,
    });
    expect(prepared.error.details).toBeUndefined();
  });

  it('clamps semantic_search limit below the minimum', async () => {
    const host = mockHost();
    await executeToolCall(createTools(), call('semantic_search', { query: 'x', limit: -3 }), host);
    expect(host.semanticSearch).toHaveBeenCalledWith('x', undefined, 1);
  });
});

describe('filterToolsForHost', () => {
  it('keeps semantic_search only when the host implements it', () => {
    const withSearch = filterToolsForHost(createTools(), mockHost());
    expect(withSearch.some((tool) => tool.name === 'semantic_search')).toBe(true);

    const withoutSearch = filterToolsForHost(createTools(), mockHost({ semanticSearch: undefined }));
    expect(withoutSearch.some((tool) => tool.name === 'semantic_search')).toBe(false);
  });
});
