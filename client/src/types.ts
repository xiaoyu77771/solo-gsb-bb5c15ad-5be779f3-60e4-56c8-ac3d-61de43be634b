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
