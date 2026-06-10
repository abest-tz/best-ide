import type { ChatMessage } from '../core/types';

const MAX_PLAN_STEPS = 8;
const MAX_PLAN_FILES = 20;
const MAX_TEXT_LENGTH = 200;

export interface ComposerPlanStep {
  id: string;
  description: string;
  files: string[];
}

export interface ComposerPlanFile {
  path: string;
  reason: string;
}

export interface ComposerPlan {
  objective: string;
  steps: ComposerPlanStep[];
  files: ComposerPlanFile[];
}

const COMPOSER_PLANNER_SYSTEM_PROMPT = `You are planning a multi-file coding task inside an IDE.
Return ONLY valid JSON (no markdown) with this exact shape:
{
  "objective": "short objective",
  "steps": [
    {
      "id": "1",
      "description": "what to do",
      "files": ["src/example.ts"]
    }
  ],
  "files": [
    {
      "path": "src/example.ts",
      "reason": "why this file is involved"
    }
  ]
}
Rules:
- Produce 2-8 concrete steps.
- Include likely file paths whenever possible.
- Keep descriptions concise and implementation-focused.`;

function normalizeText(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > MAX_TEXT_LENGTH ? `${normalized.slice(0, MAX_TEXT_LENGTH - 3)}...` : normalized;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

function extractPathCandidates(rawText: string): string[] {
  const matches = rawText.match(/`([^`]+)`/g) ?? [];
  const paths = matches
    .map((match) => match.slice(1, -1).trim())
    .filter((value) => value.includes('/') || /\.[a-z0-9]+$/i.test(value));
  return [...new Set(paths.map((value) => normalizePath(value)).filter((value) => value !== ''))];
}

function fallbackPlan(objectiveHint: string, rawText?: string): ComposerPlan {
  const objective = normalizeText(objectiveHint, 'Complete the requested coding task.');
  const stepDescriptions = rawText
    ? rawText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^([-*]|\d+[.)])\s+/.test(line))
        .map((line) => line.replace(/^([-*]|\d+[.)])\s+/, ''))
    : [];
  const files = rawText ? extractPathCandidates(rawText) : [];

  const steps: ComposerPlanStep[] =
    stepDescriptions.length > 0
      ? stepDescriptions.slice(0, MAX_PLAN_STEPS).map((description, index) => ({
          id: String(index + 1),
          description: normalizeText(description, 'Apply relevant code changes.'),
          files,
        }))
      : [
          {
            id: '1',
            description: 'Investigate the relevant files and apply the requested edits.',
            files,
          },
        ];

  return {
    objective,
    steps,
    files: files.slice(0, MAX_PLAN_FILES).map((path) => ({
      path,
      reason: 'Potentially affected by the requested task.',
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = normalizePath(entry);
    if (normalized) {
      out.push(normalized);
    }
  }
  return [...new Set(out)];
}

function sanitizePlan(candidate: unknown, objectiveHint: string): ComposerPlan {
  const parsed = asRecord(candidate);
  if (!parsed) {
    return fallbackPlan(objectiveHint);
  }

  const objective = normalizeText(
    typeof parsed['objective'] === 'string' ? parsed['objective'] : objectiveHint,
    'Complete the requested coding task.'
  );

  const files: ComposerPlanFile[] = [];
  const seenPaths = new Set<string>();
  const rawFiles = Array.isArray(parsed['files']) ? parsed['files'] : [];
  for (const item of rawFiles) {
    if (files.length >= MAX_PLAN_FILES) {
      break;
    }

    if (typeof item === 'string') {
      const path = normalizePath(item);
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        files.push({ path, reason: 'Potentially affected by the requested task.' });
      }
      continue;
    }

    const fileEntry = asRecord(item);
    if (!fileEntry) {
      continue;
    }
    const path = typeof fileEntry['path'] === 'string' ? normalizePath(fileEntry['path']) : '';
    if (!path || seenPaths.has(path)) {
      continue;
    }
    const reasonSource =
      typeof fileEntry['reason'] === 'string'
        ? fileEntry['reason']
        : typeof fileEntry['intent'] === 'string'
          ? fileEntry['intent']
          : 'Potentially affected by the requested task.';
    seenPaths.add(path);
    files.push({
      path,
      reason: normalizeText(reasonSource, 'Potentially affected by the requested task.'),
    });
  }

  const rawSteps = Array.isArray(parsed['steps']) ? parsed['steps'] : [];
  const steps: ComposerPlanStep[] = [];
  for (const step of rawSteps) {
    if (steps.length >= MAX_PLAN_STEPS) {
      break;
    }
    const parsedStep = asRecord(step);
    if (!parsedStep) {
      continue;
    }
    const descriptionSource =
      typeof parsedStep['description'] === 'string'
        ? parsedStep['description']
        : typeof parsedStep['task'] === 'string'
          ? parsedStep['task']
          : '';
    const description = normalizeText(descriptionSource, '');
    if (!description) {
      continue;
    }
    const id =
      typeof parsedStep['id'] === 'string' && parsedStep['id'].trim() !== ''
        ? normalizeText(parsedStep['id'], String(steps.length + 1))
        : String(steps.length + 1);
    const stepFiles = asStringArray(parsedStep['files']);
    steps.push({ id, description, files: stepFiles });
  }

  if (steps.length === 0) {
    return fallbackPlan(objectiveHint);
  }

  return { objective, steps, files };
}

function extractJsonObject(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith('{') && fenced.endsWith('}')) {
      return fenced;
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return undefined;
}

export function buildComposerPlanMessages(taskPrompt: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: COMPOSER_PLANNER_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Create a structured plan for this coding request:\n\n${taskPrompt.trim()}`,
    },
  ];
}

export function parseComposerPlan(rawResponse: string, objectiveHint: string): ComposerPlan {
  const candidate = extractJsonObject(rawResponse);
  if (candidate) {
    try {
      return sanitizePlan(JSON.parse(candidate), objectiveHint);
    } catch {
      // Fall through to heuristic fallback below.
    }
  }
  return fallbackPlan(objectiveHint, rawResponse);
}

export function formatComposerPlan(plan: ComposerPlan): string {
  const lines = [`Objective: ${plan.objective}`, 'Steps:'];
  for (const step of plan.steps) {
    const fileSuffix = step.files.length > 0 ? ` [${step.files.join(', ')}]` : '';
    lines.push(`${step.id}. ${step.description}${fileSuffix}`);
  }
  if (plan.files.length > 0) {
    lines.push('Files:');
    for (const file of plan.files) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
  }
  return lines.join('\n');
}

export function buildComposerExecutionPrompt(taskPrompt: string, plan: ComposerPlan): string {
  return `[Composer plan]\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n\n[Task]\n${taskPrompt}\n\nFollow the plan, adjust it if needed after investigation, apply the required edits across all affected files, and finish with a concise summary of completed steps and changed files.`;
}
