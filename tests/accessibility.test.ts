import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function readWebviewSource(relativePath: string): Promise<string> {
  const absolute = path.resolve(process.cwd(), relativePath);
  return readFile(absolute, 'utf-8');
}

describe('accessibility roadmap contributions', () => {
  it('adds screen-reader friendly transcript and composer attributes', async () => {
    const appSource = await readWebviewSource('webview/App.tsx');

    expect(appSource).toContain('Skip to transcript');
    expect(appSource).toContain('Skip to composer');
    expect(appSource).toContain('role="log"');
    expect(appSource).toContain('aria-label="Conversation transcript"');
    expect(appSource).toContain('aria-label="Chat input"');
    expect(appSource).toContain('aria-describedby={`${composerHintId} ${threadMetaId}`}');
    expect(appSource).toContain('role="status"');
  });

  it('defines high-contrast and focus-visible styles', async () => {
    const styleSource = await readWebviewSource('webview/styles.ts');

    expect(styleSource).toContain('@media (forced-colors: active)');
    expect(styleSource).toContain('.header select:focus-visible');
    expect(styleSource).toContain('.transcript:focus-visible');
    expect(styleSource).toContain('.status-dot.disconnected { background: Canvas; }');
  });
});
