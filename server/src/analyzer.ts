/**
 * 路由歧义分析核心逻辑。
 *
 * 路由模式由 `/` 分隔的段组成，段有三种：
 *  - static:  字面量，精确匹配一个段
 *  - param:   `:name`，匹配任意一个非空段
 *  - star:    `*`，匹配零个或多个段
 *
 * 冲突判定：两条规则存在共同匹配的具体路径即冲突。
 * 见证路径：把每条规则看作一个段级 NFA，在二者的积自动机上做 0-1 BFS，
 *           星号“跳过”是 0 代价 epsilon 边，消费一个段是 1 代价边，
 *           得到的即段数最短的具体见证路径。
 */

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface RuleInput {
  pattern: string;
  priority: number;
  enabled: boolean;
}

export interface AnalyzedRule {
  id: string; // R1、R2……按输入顺序
  index: number;
  pattern: string; // 规范化后的模式（保证以 / 开头）
  priority: number;
  enabled: boolean;
  segments: Segment[];
  error: string | null;
}

export interface ConflictPair {
  a: string; // 规则 id
  b: string;
  witness: string; // 最短共同命中的具体路径
  winner: string | null; // 所有启用规则中模拟最终命中的规则 id
  winnerInPair: boolean; // 胜出者是否就是冲突对之一
}

export interface AnalysisResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
}

// ---------- 变更影响分析 ----------

/** 影响分类：命中迁移 / 新增命中 / 变为未命中 / 无变化 */
export type ImpactCategory = 'migrated' | 'new-hit' | 'became-unmatched' | 'unchanged';

export interface SampleSpec {
  line: number; // 原始输入中的行号（从 1 开始）
  path: string; // 规范化后的路径
  count: number; // 请求次数（≥1）
}

export interface SampleParseError {
  line: number;
  raw: string;
  error: string;
}

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

export interface ImpactCategorySummary {
  samples: number; // 该分类下的样本条数
  requests: number; // 该分类下的请求次数合计
}

export interface ImpactSummary {
  totalSamples: number;
  totalRequests: number;
  affectedSamples: number; // 分类非「无变化」的样本条数
  affectedRequests: number; // 分类非「无变化」的请求次数合计
  categories: Record<ImpactCategory, ImpactCategorySummary>;
}

export interface ImpactResult {
  baselineRules: AnalyzedRule[];
  candidateRules: AnalyzedRule[];
  entries: ImpactEntry[];
  sampleErrors: SampleParseError[];
  summary: ImpactSummary;
}

export const MAX_SAMPLE_COUNT = 1_000_000_000;
export const MAX_SAMPLE_PATH_LEN = 2000;

export interface MatchResult {
  path: string;
  matches: string[]; // 所有命中的启用规则 id，按胜出顺序排列
  winner: string | null;
}

const PARAM_PLACEHOLDER = 'x'; // 见证路径中为参数段生成的具体值

/** 把模式字符串解析为段序列；非法时抛出带说明的错误。 */
export function parsePattern(raw: string): Segment[] {
  const pattern = raw.trim();
  if (!pattern) throw new Error('模式为空');
  const parts = pattern.split('/').filter((p) => p.length > 0);
  return parts.map((part) => {
    if (part === '*') return { kind: 'star' };
    if (part.includes('*')) {
      throw new Error(`段 "${part}" 非法：* 必须单独成段`);
    }
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!name) throw new Error('参数段 ":" 缺少名称');
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`参数名 "${name}" 非法`);
      }
      return { kind: 'param', name };
    }
    return { kind: 'static', value: part };
  });
}

/** 规范化模式：保证以 / 开头，去掉多余斜杠。 */
export function normalizePattern(raw: string): string {
  const parts = raw.trim().split('/').filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

/** 把具体路径切分为段。 */
export function splitPath(path: string): string[] {
  return path.trim().split('/').filter((p) => p.length > 0);
}

/** 判断规则段序列是否匹配给定具体路径段（* 匹配零或多段）。 */
export function matchSegments(segments: Segment[], pathSegs: string[]): boolean {
  const n = segments.length;
  const m = pathSegs.length;
  // dp[i][j]：segments[i:] 是否匹配 pathSegs[j:]
  const dp: boolean[][] = Array.from({ length: n + 1 }, () =>
    new Array<boolean>(m + 1).fill(false),
  );
  dp[n][m] = true;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      const seg = segments[i];
      if (seg.kind === 'star') {
        // 匹配零段，或消费一段后仍在星号状态
        dp[i][j] = dp[i + 1][j] || (j < m && dp[i][j + 1]);
      } else if (j < m) {
        const one =
          seg.kind === 'static' ? pathSegs[j] === seg.value : true; // param 匹配任意单段
        dp[i][j] = one && dp[i + 1][j + 1];
      }
    }
  }
  return dp[0][0];
}

/**
 * 计算两条规则段序列的最短共同见证路径（段数组），不存在时返回 null。
 * 在积自动机 (i, j) 上做 0-1 BFS：星号跳过为 0 代价边，消费一段为 1 代价边。
 */
export function intersectionWitness(a: Segment[], b: Segment[]): string[] | null {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const idx = (i: number, j: number) => i * width + j;
  const start = idx(0, 0);
  const target = idx(n, m);

  const dist = new Array<number>((n + 1) * (m + 1)).fill(Infinity);
  const prev = new Array<number>(dist.length).fill(-1);
  const prevSeg = new Array<string>(dist.length).fill('');
  const deque: number[] = [];
  dist[start] = 0;
  deque.push(start);

  const relax = (from: number, to: number, cost: number, seg: string | null) => {
    if (dist[from] + cost < dist[to]) {
      dist[to] = dist[from] + cost;
      prev[to] = from;
      prevSeg[to] = seg ?? '';
      if (cost === 0) deque.unshift(to);
      else deque.push(to);
    }
  };

  while (deque.length > 0) {
    const cur = deque.shift()!;
    const i = Math.floor(cur / width);
    const j = cur % width;
    const sa = i < n ? a[i] : null;
    const sb = j < m ? b[j] : null;

    // 0 代价边：星号匹配零段
    if (sa && sa.kind === 'star') relax(cur, idx(i + 1, j), 0, null);
    if (sb && sb.kind === 'star') relax(cur, idx(i, j + 1), 0, null);

    // 1 代价边：双方同时消费同一个具体段（一方已结束时无法再共同消费）
    if (sa && sb) {
      if (sa.kind === 'static' && sb.kind === 'static') {
        if (sa.value === sb.value) relax(cur, idx(i + 1, j + 1), 1, sa.value);
      } else if (sa.kind === 'static') {
        // b 为 param 或 star，具体段取 a 的字面量
        relax(cur, idx(i + 1, sb.kind === 'star' ? j : j + 1), 1, sa.value);
      } else if (sb.kind === 'static') {
        relax(cur, idx(sa.kind === 'star' ? i : i + 1, j + 1), 1, sb.value);
      } else {
        // param/star 组合：用占位具体段
        const ni = sa.kind === 'star' ? i : i + 1;
        const nj = sb.kind === 'star' ? j : j + 1;
        relax(cur, idx(ni, nj), 1, PARAM_PLACEHOLDER);
      }
    }
  }

  if (!Number.isFinite(dist[target])) return null;

  const segs: string[] = [];
  let cur = target;
  while (cur !== start) {
    const p = prev[cur];
    if (p < 0) return null;
    if (dist[cur] - dist[p] === 1) segs.unshift(prevSeg[cur]);
    cur = p;
  }
  return segs;
}

/** 在启用且合法的规则中，为给定路径段找出最终命中的规则（优先级大者先，平手按输入顺序）。 */
export function findWinner(
  rules: AnalyzedRule[],
  pathSegs: string[],
): AnalyzedRule | null {
  let best: AnalyzedRule | null = null;
  for (const rule of rules) {
    if (!rule.enabled || rule.error) continue;
    if (!matchSegments(rule.segments, pathSegs)) continue;
    if (
      !best ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && rule.index < best.index)
    ) {
      best = rule;
    }
  }
  return best;
}

/** 解析输入规则为 AnalyzedRule 列表（含错误信息，不做冲突分析）。 */
export function parseRules(inputs: RuleInput[]): AnalyzedRule[] {
  return inputs.map((input, index) => {
    const base = {
      id: `R${index + 1}`,
      index,
      priority: Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0,
      enabled: input.enabled !== false,
      pattern: '',
      segments: [] as Segment[],
      error: null as string | null,
    };
    try {
      base.pattern = normalizePattern(String(input.pattern ?? ''));
      base.segments = parsePattern(String(input.pattern ?? ''));
    } catch (err) {
      base.pattern = String(input.pattern ?? '').trim() || '(空)';
      base.error = err instanceof Error ? err.message : String(err);
    }
    return base;
  });
}

/** 完整分析：解析规则、两两求交找冲突、为每个冲突模拟最终命中。 */
export function analyze(inputs: RuleInput[]): AnalysisResult {
  const rules = parseRules(inputs);

  const usable = rules.filter((r) => r.enabled && !r.error);
  const conflicts: ConflictPair[] = [];
  for (let x = 0; x < usable.length; x++) {
    for (let y = x + 1; y < usable.length; y++) {
      const ra = usable[x];
      const rb = usable[y];
      const witnessSegs = intersectionWitness(ra.segments, rb.segments);
      if (!witnessSegs) continue;
      const winner = findWinner(rules, witnessSegs);
      conflicts.push({
        a: ra.id,
        b: rb.id,
        witness: '/' + witnessSegs.join('/'),
        winner: winner ? winner.id : null,
        winnerInPair: winner !== null && (winner.id === ra.id || winner.id === rb.id),
      });
    }
  }
  return { rules, conflicts };
}

/** 模拟单条具体路径的最终命中。 */
export function simulate(inputs: RuleInput[], path: string): MatchResult {
  const { rules } = analyze(inputs);
  const pathSegs = splitPath(path);
  const hits = rules
    .filter((r) => r.enabled && !r.error && matchSegments(r.segments, pathSegs))
    .sort((x, y) => y.priority - x.priority || x.index - y.index);
  return {
    path: '/' + pathSegs.join('/'),
    matches: hits.map((r) => r.id),
    winner: hits.length > 0 ? hits[0].id : null,
  };
}

/**
 * 解析请求样本：每行「次数 路径」或「路径」（次数缺省为 1）。
 * 空行与 # 注释行跳过；非法行记入 errors 且不产生样本。
 */
export function parseSamples(text: string): {
  samples: SampleSpec[];
  errors: SampleParseError[];
} {
  const samples: SampleSpec[] = [];
  const errors: SampleParseError[] = [];
  text.split('\n').forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const fail = (error: string) => errors.push({ line: lineNo, raw: trimmed, error });

    const tokens = trimmed.split(/\s+/);
    let count = 1;
    let pathToken: string;
    if (tokens.length === 1) {
      if (/^-?\d+$/.test(tokens[0])) {
        fail('只有次数，缺少路径');
        return;
      }
      pathToken = tokens[0];
    } else if (tokens.length === 2) {
      const countToken = tokens[0];
      if (!/^-?\d+$/.test(countToken)) {
        fail(`次数 "${countToken}" 非法：需为正整数`);
        return;
      }
      count = parseInt(countToken, 10);
      pathToken = tokens[1];
    } else {
      fail('格式非法：应为「次数 路径」或「路径」');
      return;
    }

    if (count < 1) {
      fail(`次数 "${tokens[0]}" 非法：需为正整数`);
      return;
    }
    if (!Number.isSafeInteger(count) || count > MAX_SAMPLE_COUNT) {
      fail(`次数过大（上限 ${MAX_SAMPLE_COUNT}）`);
      return;
    }
    if (!pathToken.startsWith('/')) {
      fail(`路径 "${pathToken}" 非法：须以 / 开头`);
      return;
    }
    if (pathToken.length > MAX_SAMPLE_PATH_LEN) {
      fail(`路径过长（上限 ${MAX_SAMPLE_PATH_LEN} 字符）`);
      return;
    }
    samples.push({ line: lineNo, path: '/' + splitPath(pathToken).join('/'), count });
  });
  return { samples, errors };
}

/**
 * 变更影响分析：对每条样本分别在基线与候选规则下求最终命中，
 * 按「命中迁移 / 新增命中 / 变为未命中 / 无变化」分类并汇总请求次数。
 * 两侧胜出者视为同一规则当且仅当规范化模式与优先级均相同。
 */
export function impact(
  baselineInputs: RuleInput[],
  candidateInputs: RuleInput[],
  sampleText: string,
): ImpactResult {
  const baselineRules = parseRules(baselineInputs);
  const candidateRules = parseRules(candidateInputs);
  const { samples, errors } = parseSamples(sampleText);

  const categories: Record<ImpactCategory, ImpactCategorySummary> = {
    migrated: { samples: 0, requests: 0 },
    'new-hit': { samples: 0, requests: 0 },
    'became-unmatched': { samples: 0, requests: 0 },
    unchanged: { samples: 0, requests: 0 },
  };

  const toWinner = (r: AnalyzedRule): ImpactWinner => ({
    id: r.id,
    pattern: r.pattern,
    priority: r.priority,
  });

  const entries: ImpactEntry[] = samples.map((s) => {
    const pathSegs = splitPath(s.path);
    const b = findWinner(baselineRules, pathSegs);
    const c = findWinner(candidateRules, pathSegs);
    let category: ImpactCategory;
    if (!b && !c) category = 'unchanged';
    else if (!b) category = 'new-hit';
    else if (!c) category = 'became-unmatched';
    else if (b.pattern === c.pattern && b.priority === c.priority) category = 'unchanged';
    else category = 'migrated';
    categories[category].samples += 1;
    categories[category].requests += s.count;
    return {
      line: s.line,
      path: s.path,
      count: s.count,
      category,
      baselineWinner: b ? toWinner(b) : null,
      candidateWinner: c ? toWinner(c) : null,
    };
  });

  const totalRequests = samples.reduce((acc, s) => acc + s.count, 0);
  return {
    baselineRules,
    candidateRules,
    entries,
    sampleErrors: errors,
    summary: {
      totalSamples: samples.length,
      totalRequests,
      affectedSamples: categories.migrated.samples + categories['new-hit'].samples + categories['became-unmatched'].samples,
      affectedRequests: categories.migrated.requests + categories['new-hit'].requests + categories['became-unmatched'].requests,
      categories,
    },
  };
}
