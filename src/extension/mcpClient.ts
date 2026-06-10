import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 15_000;

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

interface McpToolEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

interface McpListToolsResponse {
  tools: McpToolEntry[];
  nextCursor?: string;
}

interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

interface McpRequestOptions {
  timeout?: number;
}

export interface McpSession {
  listTools(params?: { cursor?: string }, options?: McpRequestOptions): Promise<McpListToolsResponse>;
  callTool(params: McpCallToolParams, options?: McpRequestOptions): Promise<unknown>;
  close(): Promise<void>;
}

type McpSessionFactory = (serverName: string, server: McpServerConfig) => Promise<McpSession>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeEnv(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (typeof rawValue === 'string') {
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      normalized[key] = String(rawValue);
    }
  }
  return normalized;
}

export function normalizeMcpServerConfigs(raw: unknown): Record<string, McpServerConfig> {
  const settings = asRecord(raw);
  if (!settings) {
    return {};
  }

  const normalized: Record<string, McpServerConfig> = {};
  for (const [serverName, entry] of Object.entries(settings)) {
    const server = asRecord(entry);
    if (!server) {
      continue;
    }
    const command = typeof server.command === 'string' ? server.command.trim() : '';
    if (command === '') {
      continue;
    }
    const cwd = typeof server.cwd === 'string' && server.cwd.trim() !== '' ? server.cwd.trim() : undefined;
    normalized[serverName] = {
      command,
      args: normalizeStringArray(server.args),
      env: normalizeEnv(server.env),
      ...(cwd ? { cwd } : {}),
    };
  }
  return normalized;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  }
  return Math.min(120_000, Math.max(1_000, Math.floor(timeoutMs)));
}

function toJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function formatToolContentPart(part: unknown): string {
  const objectPart = asRecord(part);
  if (!objectPart) {
    return toJson(part);
  }
  if (objectPart.type === 'text' && typeof objectPart.text === 'string') {
    return objectPart.text;
  }
  return toJson(objectPart);
}

export function formatMcpToolCallResult(result: unknown): string {
  const objectResult = asRecord(result);
  if (!objectResult) {
    return toJson(result);
  }

  if ('toolResult' in objectResult) {
    return toJson(objectResult.toolResult);
  }

  const sections: string[] = [];
  if (Array.isArray(objectResult.content)) {
    const renderedContent = objectResult.content.map((part) => formatToolContentPart(part));
    if (renderedContent.length > 0) {
      sections.push(renderedContent.join('\n'));
    }
  }
  if ('structuredContent' in objectResult) {
    sections.push(`structuredContent:\n${toJson(objectResult.structuredContent)}`);
  }
  if (objectResult.isError === true) {
    sections.push('isError: true');
  }
  return sections.length > 0 ? sections.join('\n\n') : toJson(objectResult);
}

export function formatMcpToolList(tools: McpToolInfo[]): string {
  if (tools.length === 0) {
    return '(no MCP tools available)';
  }
  return tools
    .map((tool) => {
      const hints: string[] = [];
      if (tool.readOnlyHint) {
        hints.push('read-only');
      }
      if (tool.destructiveHint) {
        hints.push('destructive');
      }
      const header = `${tool.server}.${tool.name}${hints.length > 0 ? ` (${hints.join(', ')})` : ''}`;
      const lines = [header];
      if (tool.description && tool.description.trim() !== '') {
        lines.push(tool.description.trim());
      }
      if (tool.inputSchema) {
        lines.push(`input_schema: ${toJson(tool.inputSchema)}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

async function createSdkSession(_serverName: string, server: McpServerConfig): Promise<McpSession> {
  const client = new Client({ name: 'best-ide-agent', version: '0.1.0' }, { capabilities: {} });
  const mergedEnv = { ...process.env, ...server.env };
  const transport = new StdioClientTransport({
    command: server.command,
    ...(server.args.length > 0 ? { args: server.args } : {}),
    env: Object.fromEntries(
      Object.entries(mergedEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    ),
    ...(server.cwd ? { cwd: server.cwd } : {}),
  });
  await client.connect(transport);
  return {
    listTools: (params, options) => client.listTools(params, options),
    callTool: (params, options) => client.callTool(params, undefined, options),
    close: () => client.close(),
  };
}

export class McpClientManager {
  private readonly sessionFactory: McpSessionFactory;

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    sessionFactory?: McpSessionFactory
  ) {
    this.sessionFactory = sessionFactory ?? createSdkSession;
  }

  hasServers(): boolean {
    return Object.keys(this.servers).length > 0;
  }

  async listTools(serverName?: string, timeoutMs?: number): Promise<McpToolInfo[]> {
    const timeout = normalizeTimeoutMs(timeoutMs);
    const targets = serverName ? [serverName] : Object.keys(this.servers).sort((a, b) => a.localeCompare(b));
    if (targets.length === 0) {
      return [];
    }
    const results: McpToolInfo[] = [];
    for (const target of targets) {
      await this.withSession(target, async (session) => {
        let cursor: string | undefined;
        do {
          const page = await session.listTools(cursor ? { cursor } : undefined, { timeout });
          for (const tool of page.tools) {
            results.push({
              server: target,
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
              readOnlyHint: tool.annotations?.readOnlyHint === true,
              destructiveHint: tool.annotations?.destructiveHint === true,
            });
          }
          cursor = page.nextCursor;
        } while (cursor);
      });
    }
    return results.sort((a, b) =>
      a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server)
    );
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<string> {
    const timeout = normalizeTimeoutMs(timeoutMs);
    return this.withSession(serverName, async (session) => {
      const result = await session.callTool(
        {
          name: toolName,
          ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
        },
        { timeout }
      );
      return formatMcpToolCallResult(result);
    });
  }

  async dispose(): Promise<void> {
    // Sessions are short-lived per request, so there is nothing to dispose.
  }

  private async withSession<T>(
    serverName: string,
    run: (session: McpSession) => Promise<T>
  ): Promise<T> {
    const config = this.servers[serverName];
    if (!config) {
      throw new Error(`unknown MCP server "${serverName}"`);
    }
    const session = await this.sessionFactory(serverName, config);
    try {
      return await run(session);
    } finally {
      await session.close().catch(() => {
        // Ignore close failures after request completion.
      });
    }
  }
}
