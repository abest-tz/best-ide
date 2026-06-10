import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface CommandContribution {
  command: string;
}

interface KeybindingContribution {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

interface ExtensionPackageJson {
  contributes?: {
    commands?: CommandContribution[];
    keybindings?: KeybindingContribution[];
  };
}

async function readPackageJson(): Promise<ExtensionPackageJson> {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const content = await readFile(packagePath, 'utf-8');
  return JSON.parse(content) as ExtensionPackageJson;
}

function getKeybinding(
  keybindings: KeybindingContribution[] | undefined,
  command: string
): KeybindingContribution {
  const binding = keybindings?.find((entry) => entry.command === command);
  expect(binding).toBeDefined();
  return binding as KeybindingContribution;
}

describe('keyboard-first roadmap contributions', () => {
  it('contributes a dedicated focus chat command', async () => {
    const pkg = await readPackageJson();
    const commands = pkg.contributes?.commands ?? [];
    expect(commands.some((entry) => entry.command === 'bestIde.focusChat')).toBe(true);
  });

  it('defines keyboard shortcuts for chat-focused workflows', async () => {
    const pkg = await readPackageJson();
    const keybindings = pkg.contributes?.keybindings;

    const focusChat = getKeybinding(keybindings, 'bestIde.focusChat');
    expect(focusChat.key).toBe('ctrl+alt+c');
    expect(focusChat.mac).toBe('cmd+alt+c');

    const newChat = getKeybinding(keybindings, 'bestIde.newChat');
    expect(newChat.key).toBe('ctrl+alt+n');
    expect(newChat.when).toContain('view == bestIde.chatView');

    const acceptPending = getKeybinding(keybindings, 'bestIde.acceptAgentChange');
    expect(acceptPending.key).toBe('ctrl+alt+a');
    expect(acceptPending.when).toContain('resourceScheme == bestide-pending');

    const rejectPending = getKeybinding(keybindings, 'bestIde.rejectAgentChange');
    expect(rejectPending.key).toBe('ctrl+alt+r');
    expect(rejectPending.when).toContain('resourceScheme == bestide-pending');
  });
});
