import type { WorkspaceHost } from './host';
import type { ToolCall, ToolDefinition } from './types';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  execute(args: Record<string, unknown>, host: WorkspaceHost): Promise<string>;
}

const MAX_FILE_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

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

export function createTools(): ToolSpec[] {
  return [
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
      name: 'write_file',
      description:
        'Create or overwrite a file in the workspace with the given content. Requires user approval.',
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
      name: 'run_command',
      description:
        'Run a shell command in the workspace root and return its output. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
        },
        required: ['command'],
      },
      mutating: true,
      async execute(args, host) {
        const command = requireString(args, 'command');
        const result = await host.exec(command, DEFAULT_COMMAND_TIMEOUT_MS);
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

/**
 * Executes a tool call, returning errors as strings so the agent loop can feed
 * them back to the model instead of aborting the conversation.
 */
export async function executeToolCall(
  tools: ToolSpec[],
  call: ToolCall,
  host: WorkspaceHost
): Promise<string> {
  const tool = findTool(tools, call.function.name);
  if (!tool) {
    return `Error: unknown tool "${call.function.name}"`;
  }
  try {
    const args = parseToolArguments(call.function.arguments);
    return await tool.execute(args, host);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
