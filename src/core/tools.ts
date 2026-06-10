import type { WorkspaceHost } from './host';
import type { ToolCall, ToolDefinition } from './types';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  execute(args: Record<string, unknown>, host: WorkspaceHost): Promise<string>;
}

export type ToolAccessMode = 'agent' | 'ask' | 'composer';

const MAX_FILE_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_TIMEOUT_MS = 20_000;
const MAX_READ_ONLY_TOOL_ATTEMPTS = 2;
const RETRYABLE_ERROR_PATTERNS: readonly RegExp[] = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\brate limit\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\b429\b/,
  /\b503\b/,
  /\bECONN(?:RESET|REFUSED)\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENOTFOUND\b/i,
];

type ToolErrorCode = 'unknown_tool' | 'invalid_tool_arguments' | 'tool_execution_failed';

export interface StructuredToolError {
  code: ToolErrorCode;
  tool: string;
  message: string;
  retryable: boolean;
  details?: string[];
  attempts?: number;
  maxAttempts?: number;
}

export interface PreparedToolCall {
  tool: ToolSpec;
  args: Record<string, unknown>;
}

export type PreparedToolCallResult =
  | { ok: true; prepared: PreparedToolCall }
  | { ok: false; error: StructuredToolError };

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated]`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function asOptionalBoundedInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function normalizeSchemaTypes(rawType: unknown): string[] {
  if (typeof rawType === 'string') {
    return [rawType];
  }
  if (Array.isArray(rawType)) {
    return rawType.filter((value): value is string => typeof value === 'string');
  }
  return [];
}

function valueMatchesSchemaType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return asObject(value) !== undefined;
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateArgumentsAgainstSchema(tool: ToolSpec, args: Record<string, unknown>): string[] {
  const schema = asObject(tool.parameters);
  if (!schema) {
    return [];
  }
  const properties = asObject(schema['properties']) ?? {};
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const issues: string[] = [];

  for (const key of required) {
    if (!(key in args)) {
      issues.push(`missing required argument "${key}"`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const propertySchema = asObject(properties[key]);
    if (!propertySchema) {
      continue;
    }
    const expectedTypes = normalizeSchemaTypes(propertySchema['type']);
    if (expectedTypes.length === 0) {
      continue;
    }
    const matches = expectedTypes.some((expectedType) => valueMatchesSchemaType(value, expectedType));
    if (!matches) {
      issues.push(`argument "${key}" must be ${expectedTypes.join(' or ')}; got ${describeType(value)}`);
    }
  }

  return issues;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableError(message: string): boolean {
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatToolError(error: StructuredToolError): string {
  return `Error: ${JSON.stringify(error, null, 2)}`;
}

export function createTools(mode: ToolAccessMode = 'agent'): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
        },
        required: ['path'],
      },
      mutating: false,
      async execute(args, host) {
        const path = requireString(args, 'path');
        return truncate(await host.readFile(path), MAX_FILE_CHARS);
      },
    },
    {
      name: 'list_dir',
      description: 'List files and directories at a workspace-relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative directory path. Defaults to the workspace root.',
          },
        },
      },
      mutating: false,
      async execute(args, host) {
        const path = typeof args['path'] === 'string' && args['path'] !== '' ? args['path'] : '.';
        const entries = await host.listDir(path);
        if (entries.length === 0) {
          return '(directory is empty)';
        }
        return entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).join('\n');
      },
    },
    {
      name: 'grep',
      description: 'Search file contents in the workspace with a regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          include: {
            type: 'string',
            description: 'Optional glob to restrict the search, e.g. "*.ts".',
          },
        },
        required: ['pattern'],
      },
      mutating: false,
      async execute(args, host) {
        const pattern = requireString(args, 'pattern');
        const include = typeof args['include'] === 'string' ? args['include'] : undefined;
        const result = await host.grep(pattern, include);
        if (result.trim() === '') {
          return '(no matches)';
        }
        return truncate(result, MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'semantic_search',
      description: 'Search the workspace semantically using a local embedding index.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query describing the target code.' },
          include: {
            type: 'string',
            description: 'Optional glob to restrict indexed files, e.g. "*.ts".',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of semantic matches to return (1-20, default 5).',
          },
        },
        required: ['query'],
      },
      mutating: false,
      async execute(args, host) {
        if (!host.semanticSearch) {
          throw new Error('semantic_search is not supported by this host');
        }
        const query = requireString(args, 'query');
        const include = asString(args['include']);
        const limit = asBoundedInt(args['limit'], 5, 1, 20);
        return truncate(await host.semanticSearch(query, include, limit), MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'get_diagnostics',
      description: 'List current editor diagnostics (errors/warnings) from the language server.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional workspace-relative file path to scope diagnostics.',
          },
        },
      },
      mutating: false,
      async execute(args, host) {
        if (!host.getDiagnostics) {
          throw new Error('get_diagnostics is not supported by this host');
        }
        const path = asString(args['path']);
        return truncate(await host.getDiagnostics(path), MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'get_symbols',
      description: 'List document or workspace symbols for semantic code navigation.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional symbol name filter.',
          },
          path: {
            type: 'string',
            description: 'Optional workspace-relative file path. If set, returns document symbols.',
          },
        },
      },
      mutating: false,
      async execute(args, host) {
        if (!host.getSymbols) {
          throw new Error('get_symbols is not supported by this host');
        }
        const query = asString(args['query']);
        const path = asString(args['path']);
        return truncate(await host.getSymbols(query, path), MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'git_status',
      description: 'Show current git branch and changed files (short status).',
      parameters: {
        type: 'object',
        properties: {},
      },
      mutating: false,
      async execute(_args, host) {
        const result = await host.exec('git status --short --branch', DEFAULT_GIT_TIMEOUT_MS);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `git status failed with exit code ${result.exitCode}`);
        }
        const output = result.stdout.trim();
        return output === '' ? '(clean working tree)' : truncate(output, MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'git_diff',
      description: 'Show git diff output, optionally scoped to staged changes or a specific file.',
      parameters: {
        type: 'object',
        properties: {
          staged: {
            type: 'boolean',
            description: 'If true, show staged diff (`git diff --staged`).',
          },
          path: {
            type: 'string',
            description: 'Optional workspace-relative file path.',
          },
        },
      },
      mutating: false,
      async execute(args, host) {
        const staged = args['staged'] === true;
        const path = asString(args['path']);
        const pathPart = path ? ` -- ${shellQuote(path)}` : '';
        const command = staged ? `git diff --staged${pathPart}` : `git diff${pathPart}`;
        const result = await host.exec(command, DEFAULT_GIT_TIMEOUT_MS);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `git diff failed with exit code ${result.exitCode}`);
        }
        const output = result.stdout.trim();
        return output === '' ? '(no diff)' : truncate(output, MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'mcp_list_tools',
      description: 'List tools exposed by configured MCP servers.',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Optional MCP server name to scope the list.',
          },
        },
      },
      mutating: false,
      async execute(args, host) {
        if (!host.listMcpTools) {
          throw new Error('mcp_list_tools is not supported by this host');
        }
        const server = asString(args['server']);
        return truncate(await host.listMcpTools(server), MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'mcp_call_tool',
      description: 'Call a tool from a configured MCP server.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name.' },
          tool: { type: 'string', description: 'Tool name exposed by the MCP server.' },
          arguments: {
            type: 'object',
            description: 'Arguments object passed to the MCP tool.',
          },
        },
        required: ['server', 'tool'],
      },
      mutating: true,
      async execute(args, host) {
        if (!host.callMcpTool) {
          throw new Error('mcp_call_tool is not supported by this host');
        }
        const server = requireString(args, 'server');
        const tool = requireString(args, 'tool');
        const rawArguments = args['arguments'];
        const parsedArguments = asObject(rawArguments);
        if (rawArguments !== undefined && !parsedArguments) {
          throw new Error('argument "arguments" must be an object when provided');
        }
        return truncate(await host.callMcpTool(server, tool, parsedArguments ?? {}), MAX_OUTPUT_CHARS);
      },
    },
    {
      name: 'write_file',
      description:
        'Create or overwrite a file in the workspace with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'Full new contents of the file.' },
        },
        required: ['path', 'content'],
      },
      mutating: true,
      async execute(args, host) {
        const path = requireString(args, 'path');
        const content = requireString(args, 'content');
        await host.writeFile(path, content);
        return `Wrote ${content.length} characters to ${path}`;
      },
    },
    {
      name: 'search_replace',
      description:
        'Edit part of a file by replacing an exact text snippet. Use this instead of rewriting entire files when possible.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          search: { type: 'string', description: 'Exact text to find.' },
          replace: { type: 'string', description: 'Replacement text.' },
          replaceAll: {
            type: 'boolean',
            description: 'Replace all occurrences. Defaults to false (replace exactly one).',
          },
        },
        required: ['path', 'search', 'replace'],
      },
      mutating: true,
      async execute(args, host) {
        const path = requireString(args, 'path');
        const search = requireString(args, 'search');
        const replace = requireString(args, 'replace');
        const replaceAll = args['replaceAll'] === true;

        if (search === '') {
          throw new Error('search cannot be empty');
        }

        const current = await host.readFile(path);
        const occurrences = countOccurrences(current, search);
        if (occurrences === 0) {
          throw new Error(`search text was not found in ${path}`);
        }
        if (!replaceAll && occurrences > 1) {
          throw new Error(
            `search text matched ${occurrences} locations in ${path}; set replaceAll=true or provide a more specific search string`
          );
        }

        const next = replaceAll ? current.split(search).join(replace) : current.replace(search, replace);
        await host.writeFile(path, next);
        const replacedCount = replaceAll ? occurrences : 1;
        return `Updated ${path}: replaced ${replacedCount} occurrence${replacedCount === 1 ? '' : 's'}.`;
      },
    },
    {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root and return its output. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          timeout_ms: {
            type: 'number',
            description:
              'Optional timeout override in milliseconds. The extension may clamp this based on sandbox policy.',
          },
        },
        required: ['command'],
      },
      mutating: true,
      async execute(args, host) {
        const command = requireString(args, 'command');
        const timeoutMs = asOptionalBoundedInt(args['timeout_ms'], 100, 10 * 60_000);
        const result = host.runCommand
          ? await host.runCommand(command, timeoutMs)
          : await host.exec(command, timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
        const parts = [
          `exit code: ${result.exitCode}`,
          result.stdout ? `stdout:\n${truncate(result.stdout, MAX_OUTPUT_CHARS)}` : 'stdout: (empty)',
        ];
        if (result.stderr) {
          parts.push(`stderr:\n${truncate(result.stderr, MAX_OUTPUT_CHARS)}`);
        }
        return parts.join('\n');
      },
    },
  ];
  if (mode === 'ask') {
    return tools.filter((tool) => !tool.mutating);
  }
  return tools;
}

export function toToolDefinitions(tools: ToolSpec[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function findTool(tools: ToolSpec[], name: string): ToolSpec | undefined {
  return tools.find((tool) => tool.name === name);
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`could not parse tool arguments as JSON: ${raw.slice(0, 200)}`);
  }
}

export function prepareToolCall(tools: ToolSpec[], call: ToolCall): PreparedToolCallResult {
  const tool = findTool(tools, call.function.name);
  if (!tool) {
    return {
      ok: false,
      error: {
        code: 'unknown_tool',
        tool: call.function.name,
        message: `unknown tool "${call.function.name}"`,
        retryable: true,
        ...(tools.length > 0
          ? {
              details: [
                `available tools: ${tools
                  .map((candidate) => candidate.name)
                  .sort((a, b) => a.localeCompare(b))
                  .join(', ')}`,
              ],
            }
          : {}),
      },
    };
  }

  let args: Record<string, unknown>;
  try {
    args = parseToolArguments(call.function.arguments);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'invalid_tool_arguments',
        tool: tool.name,
        message: toErrorMessage(error),
        retryable: true,
        details: ['arguments must be a valid JSON object'],
      },
    };
  }

  const issues = validateArgumentsAgainstSchema(tool, args);
  if (issues.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_tool_arguments',
        tool: tool.name,
        message: `tool arguments failed validation for "${tool.name}"`,
        retryable: true,
        details: issues,
      },
    };
  }

  return {
    ok: true,
    prepared: {
      tool,
      args,
    },
  };
}

export async function executePreparedToolCall(
  prepared: PreparedToolCall,
  host: WorkspaceHost
): Promise<string> {
  const maxAttempts = prepared.tool.mutating ? 1 : MAX_READ_ONLY_TOOL_ATTEMPTS;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      return await prepared.tool.execute(prepared.args, host);
    } catch (error) {
      const message = toErrorMessage(error);
      const retryable = isRetryableError(message);
      if (!prepared.tool.mutating && retryable && attempts < maxAttempts) {
        continue;
      }
      return formatToolError({
        code: 'tool_execution_failed',
        tool: prepared.tool.name,
        message,
        retryable,
        ...(maxAttempts > 1 ? { attempts, maxAttempts } : {}),
      });
    }
  }

  return formatToolError({
    code: 'tool_execution_failed',
    tool: prepared.tool.name,
    message: `tool execution failed for "${prepared.tool.name}"`,
    retryable: false,
  });
}

/**
 * Executes a tool call, returning errors as strings so the agent loop can feed
 * them back to the model instead of aborting the conversation.
 */
export async function executeToolCall(
  tools: ToolSpec[],
  call: ToolCall,
  host: WorkspaceHost
): Promise<string> {
  const prepared = prepareToolCall(tools, call);
  if (!prepared.ok) {
    return formatToolError(prepared.error);
  }
  return executePreparedToolCall(prepared.prepared, host);
}
