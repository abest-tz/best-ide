import { describe, expect, it } from 'vitest';
import { buildSkillCandidatePaths, resolveSkillFile } from '../src/extension/skills';

function readFrom(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path: string) => {
    if (!(path in files)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return files[path]!;
  };
}

describe('buildSkillCandidatePaths', () => {
  it('builds markdown and folder candidates for a bare skill name', () => {
    expect(buildSkillCandidatePaths('review')).toEqual([
      '.bestide/skills/review.md',
      '.bestide/skills/review/SKILL.md',
    ]);
  });

  it('keeps explicit markdown paths as-is', () => {
    expect(buildSkillCandidatePaths('review/security.md')).toEqual([
      '.bestide/skills/review/security.md',
    ]);
  });
});

describe('resolveSkillFile', () => {
  it('loads markdown skill files', async () => {
    const skill = await resolveSkillFile(
      'test-driven',
      readFrom({ '.bestide/skills/test-driven.md': 'Write tests first.' })
    );
    expect(skill).toEqual({
      name: 'test-driven',
      path: '.bestide/skills/test-driven.md',
      content: 'Write tests first.',
    });
  });

  it('falls back to folder SKILL.md when markdown file is missing', async () => {
    const skill = await resolveSkillFile(
      'refactor',
      readFrom({ '.bestide/skills/refactor/SKILL.md': 'Keep changes small.' })
    );
    expect(skill.path).toBe('.bestide/skills/refactor/SKILL.md');
    expect(skill.content).toBe('Keep changes small.');
  });

  it('rejects path traversal and invalid names', async () => {
    await expect(resolveSkillFile('../secrets', readFrom({}))).rejects.toThrow(/invalid skill name/i);
  });

  it('errors when no candidate file exists', async () => {
    await expect(resolveSkillFile('missing', readFrom({}))).rejects.toThrow(
      /was not found under \.bestide\/skills/i
    );
  });

  it('errors when the skill file exists but is empty', async () => {
    await expect(
      resolveSkillFile('empty', readFrom({ '.bestide/skills/empty.md': '   ' }))
    ).rejects.toThrow(/is empty/i);
  });
});
