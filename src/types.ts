export type DiffType = 'add' | 'delete' | 'unchanged';

export interface DiffLine {
  type: DiffType;
  content: string;
}

export interface DiffResult {
  oldLines: string[];
  newLines: string[];
  diff: DiffLine[];
}
