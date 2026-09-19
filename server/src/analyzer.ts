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

/** 完整分析：解析规则、两两求交找冲突、为每个冲突模拟最终命中。 */
export function analyze(inputs: RuleInput[]): AnalysisResult {
  const rules: AnalyzedRule[] = inputs.map((input, index) => {
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
