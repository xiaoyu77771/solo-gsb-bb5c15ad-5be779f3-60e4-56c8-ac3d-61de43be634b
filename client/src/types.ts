// 与后端 analyzer.ts 对应的类型定义
export interface RuleInput {
  pattern: string;
  priority: number;
  enabled: boolean;
}

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface AnalyzedRule {
  id: string;
  index: number;
  pattern: string;
  priority: number;
  enabled: boolean;
  segments: Segment[];
  error: string | null;
}

export interface ConflictPair {
  a: string;
  b: string;
  witness: string;
  winner: string | null;
  winnerInPair: boolean;
}

export interface AnalysisResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
}

export interface MatchResult {
  path: string;
  matches: string[];
  winner: string | null;
}

// ---------- 变更影响 ----------

export type ImpactCategory = 'migrated' | 'new-hit' | 'became-unmatched' | 'unchanged';

export interface ImpactWinner {
  id: string;
  pattern: string;
  priority: number;
}

export interface ImpactEntry {
  line: number;
  path: string;
  count: number;
  category: ImpactCategory;
  baselineWinner: ImpactWinner | null;
  candidateWinner: ImpactWinner | null;
}

export interface SampleParseError {
  line: number;
  raw: string;
  error: string;
}

export interface ImpactCategorySummary {
  samples: number;
  requests: number;
}

export interface ImpactSummary {
  totalSamples: number;
  totalRequests: number;
  affectedSamples: number;
  affectedRequests: number;
  categories: Record<ImpactCategory, ImpactCategorySummary>;
}

export interface ImpactResult {
  baselineRules: AnalyzedRule[];
  candidateRules: AnalyzedRule[];
  entries: ImpactEntry[];
  sampleErrors: SampleParseError[];
  summary: ImpactSummary;
}
