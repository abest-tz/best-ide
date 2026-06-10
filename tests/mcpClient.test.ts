import { describe, expect, it, vi } from 'vitest';
import {
  formatMcpToolCallResult,
  formatMcpToolList,
  McpClientManager,
  normalizeMcpServerConfigs,
} from '../src/extension/mcpClient';

describe('normalizeMcpServerConfigs', () => {
  it('keeps only valid server definitions and normalizes args/env', () => {
    const normalized = normalizeMcpServerConfigs({
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github', 123],
        env: { GITHUB_TOKEN: 'token', DEBUG: true },
        cwd: 'tools',
      },
      broken: { args: ['missing-command'] },
      invalid: 'nope',
    });

    expect(normalized).toEqual({
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'token', DEBUG: 'true' },
        cwd: 'tools',
      },
    });
  });
});

describe('McpClientManager', () => {
  it('lists tools with pagination and timeout forwarding', async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [{ name: 'list_issues', description: 'List issues', annotations: { readOnlyHint: true } }],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        tools: [{ name: 'create_issue', annotations: { destructiveHint: true } }],
      });
    const close = vi.fn().mockResolvedValue(undefined);
    const manager = new McpClientManager(
      {
        github: { command: 'npx', args: [], env: {} },
      },
      vi.fn().mockResolvedValue({
        listTools,
        callTool: vi.fn(),
        close,
      })
    );

    const tools = await manager.listTools('github', 4200);

    expect(listTools).toHaveBeenNthCalledWith(1, undefined, { timeout: 4200 });
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: 'cursor-2' }, { timeout: 4200 });
    expect(close).toHaveBeenCalledOnce();
    expect(tools.map((tool) => `${tool.server}.${tool.name}`)).toEqual([
      'github.create_issue',
      'github.list_issues',
    ]);
    expect(tools[0]?.destructiveHint).toBe(true);
    expect(tools[1]?.readOnlyHint).toBe(true);
  });

  it('calls a tool and formats mixed results', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Issue created' }],
      structuredContent: { issueId: 123 },
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const manager = new McpClientManager(
      {
        github: { command: 'npx', args: [], env: {} },
      },
      vi.fn().mockResolvedValue({
        listTools: vi.fn(),
        callTool,
        close,
      })
    );

    const result = await manager.callTool('github', 'create_issue', { title: 'Bug' }, 9000);

    expect(callTool).toHaveBeenCalledWith(
      { name: 'create_issue', arguments: { title: 'Bug' } },
      { timeout: 9000 }
    );
    expect(result).toContain('Issue created');
    expect(result).toContain('structuredContent');
    expect(close).toHaveBeenCalledOnce();
  });

  it('throws for unknown servers', async () => {
    const manager = new McpClientManager({});
    await expect(manager.callTool('missing', 'x', {})).rejects.toThrow(/unknown MCP server/i);
  });
});

describe('MCP output formatting', () => {
  it('renders list and call outputs into readable text', () => {
    const listOutput = formatMcpToolList([
      {
        server: 'github',
        name: 'list_issues',
        description: 'List repository issues',
        inputSchema: { type: 'object', properties: { owner: { type: 'string' } } },
        readOnlyHint: true,
        destructiveHint: false,
      },
    ]);
    const callOutput = formatMcpToolCallResult({
      content: [{ type: 'text', text: 'ok' }],
      isError: true,
    });

    expect(listOutput).toContain('github.list_issues (read-only)');
    expect(listOutput).toContain('input_schema');
    expect(callOutput).toContain('ok');
    expect(callOutput).toContain('isError: true');
  });
});
