import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeRules, computeImpact, matchPath } from './api';
import type {
  AnalysisResult,
  ImpactCategory,
  ImpactResult,
  ImpactWinner,
  MatchResult,
  RuleInput,
} from './types';

const EXAMPLE = `# 每行一条规则：<优先级> <路由模式>
# :param 匹配单个段，* 匹配零个或多个段
# 优先级数字越大越先命中，平手按输入顺序
100 /api/users/:id
10  /api/users/new
90  /api/users/new
1   /api/*
0   /health
`;

const CANDIDATE_EXAMPLE = `# 候选规则：格式与基线相同（<优先级> <路由模式>）
100 /api/users/:id
105 /api/users/new
1   /api/*
3   /healthz
`;

const SAMPLES_EXAMPLE = `# 每行一个请求样本：次数 路径（次数省略时为 1）
# 非法行会被逐行标出，不参与统计
120 /api/users/new
30  /api/users/42
15  /health
8   /healthz
50  /api/internal/metrics
3   /nowhere
`;

const IMPACT_CATEGORIES: { key: ImpactCategory; label: string }[] = [
  { key: 'migrated', label: '命中迁移' },
  { key: 'new-hit', label: '新增命中' },
  { key: 'became-unmatched', label: '变为未命中' },
  { key: 'unchanged', label: '无变化' },
];

const categoryLabel = (key: ImpactCategory) =>
  IMPACT_CATEGORIES.find((c) => c.key === key)?.label ?? key;

/** 解析一行输入为 { priority, pattern }；空行与 # 注释返回 null。 */
function parseLine(line: string): { priority: number; pattern: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const tokens = trimmed.split(/\s+/);
  const isInt = (s: string) => /^-?\d+$/.test(s);
  if (tokens.length >= 2 && isInt(tokens[0])) {
    return { priority: parseInt(tokens[0], 10), pattern: tokens.slice(1).join(' ') };
  }
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && isInt(last)) {
    return { priority: parseInt(last, 10), pattern: tokens.slice(0, -1).join(' ') };
  }
  return { priority: 0, pattern: trimmed };
}

/** 把规则文本解析为 RuleInput 列表。 */
function parseRuleText(text: string, isEnabled: (index: number) => boolean): RuleInput[] {
  const out: RuleInput[] = [];
  text.split('\n').forEach((line) => {
    const parsed = parseLine(line);
    if (parsed) out.push({ ...parsed, enabled: isEnabled(out.length) });
  });
  return out;
}

export default function App() {
  const [mode, setMode] = useState<'analyze' | 'impact'>('analyze');
  const [text, setText] = useState(EXAMPLE);
  const [disabled, setDisabled] = useState<Set<number>>(new Set());
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [testPath, setTestPath] = useState('/api/users/new');
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [candidateText, setCandidateText] = useState(CANDIDATE_EXAMPLE);
  const [samplesText, setSamplesText] = useState(SAMPLES_EXAMPLE);
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<'all' | ImpactCategory>('all');

  // 文本 → 规则输入（含启用状态），即变更影响模式的基线
  const ruleInputs: RuleInput[] = useMemo(
    () => parseRuleText(text, (i) => !disabled.has(i)),
    [text, disabled],
  );

  // 候选规则：同一解析语义，不参与启用勾选
  const candidateInputs: RuleInput[] = useMemo(
    () => parseRuleText(candidateText, () => true),
    [candidateText],
  );

  // 即时重算：输入或禁用状态变化后防抖调用后端
  const analyzeSeq = useRef(0);
  useEffect(() => {
    const seq = ++analyzeSeq.current;
    const timer = setTimeout(() => {
      analyzeRules(ruleInputs)
        .then((result) => {
          if (seq !== analyzeSeq.current) return;
          setAnalysis(result);
          setAnalyzeError(null);
        })
        .catch((err: Error) => {
          if (seq !== analyzeSeq.current) return;
          setAnalyzeError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [ruleInputs]);

  // 路径模拟
  const matchSeq = useRef(0);
  useEffect(() => {
    const seq = ++matchSeq.current;
    if (!testPath.trim()) {
      setMatchResult(null);
      return;
    }
    const timer = setTimeout(() => {
      matchPath(ruleInputs, testPath)
        .then((result) => {
          if (seq !== matchSeq.current) return;
          setMatchResult(result);
        })
        .catch(() => {
          if (seq !== matchSeq.current) return;
          setMatchResult(null);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [ruleInputs, testPath]);

  // 变更影响：基线/候选规则或样本变化后防抖重算，丢弃过期响应
  const impactSeq = useRef(0);
  useEffect(() => {
    const seq = ++impactSeq.current;
    if (mode !== 'impact') return;
    const timer = setTimeout(() => {
      computeImpact(ruleInputs, candidateInputs, samplesText)
        .then((result) => {
          if (seq !== impactSeq.current) return;
          setImpact(result);
          setImpactError(null);
        })
        .catch((err: Error) => {
          if (seq !== impactSeq.current) return;
          setImpactError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [mode, ruleInputs, candidateInputs, samplesText]);

  const toggleRule = (index: number) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const ruleById = useMemo(() => {
    const map = new Map<string, AnalysisResult['rules'][number]>();
    analysis?.rules.forEach((r) => map.set(r.id, r));
    return map;
  }, [analysis]);

  const downloadJson = (payload: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJson = () => {
    if (!analysis) return;
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      exportedAt: new Date().toISOString(),
      rules: analysis.rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.error ? { error: r.error } : {}),
      })),
      conflicts: analysis.conflicts.map((c) => ({
        ruleA: c.a,
        ruleB: c.b,
        witness: c.witness,
        winner: c.winner,
        winnerInPair: c.winnerInPair,
      })),
    };
    downloadJson(payload, `route-conflicts-${Date.now()}.json`);
  };

  const exportImpactJson = () => {
    if (!impact) return;
    const mapRule = (r: AnalysisResult['rules'][number]) => ({
      id: r.id,
      pattern: r.pattern,
      priority: r.priority,
      enabled: r.enabled,
      ...(r.error ? { error: r.error } : {}),
    });
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      mode: 'change-impact',
      exportedAt: new Date().toISOString(),
      baselineRules: impact.baselineRules.map(mapRule),
      candidateRules: impact.candidateRules.map(mapRule),
      sampleErrors: impact.sampleErrors,
      summary: impact.summary,
      entries: impact.entries,
    };
    downloadJson(payload, `route-impact-${Date.now()}.json`);
  };

  const conflictCount = analysis?.conflicts.length ?? 0;
  const enabledCount = analysis?.rules.filter((r) => r.enabled && !r.error).length ?? 0;

  const filteredEntries = useMemo(() => {
    if (!impact) return [];
    return categoryFilter === 'all'
      ? impact.entries
      : impact.entries.filter((e) => e.category === categoryFilter);
  }, [impact, categoryFilter]);

  const baselineStats = useMemo(() => {
    const rules = impact?.baselineRules ?? [];
    return {
      enabled: rules.filter((r) => r.enabled && !r.error).length,
      errors: rules.filter((r) => r.error).length,
    };
  }, [impact]);

  const candidateStats = useMemo(() => {
    const rules = impact?.candidateRules ?? [];
    return {
      enabled: rules.filter((r) => !r.error).length,
      errors: rules.filter((r) => r.error).length,
    };
  }, [impact]);

  const winnerCell = (w: ImpactWinner | null) =>
    w ? (
      <>
        <span className="badge">{w.id}</span> <span className="mono">{w.pattern}</span>{' '}
        <span className="muted">(优先级 {w.priority})</span>
      </>
    ) : (
      <span className="muted">未命中</span>
    );

  return (
    <div className="page">
      <header className="header">
        <h1>API 网关路由歧义排查</h1>
        <p>
          粘贴路由规则，找出可能同时命中的规则对，生成最短冲突见证路径，并按优先级模拟最终命中；
          或切换到「变更影响」，以当前规则为基线评估候选规则对请求样本的影响。
        </p>
        <div className="mode-tabs">
          <button
            className={mode === 'analyze' ? 'tab tab-active' : 'tab'}
            onClick={() => setMode('analyze')}
          >
            歧义分析
          </button>
          <button
            className={mode === 'impact' ? 'tab tab-active' : 'tab'}
            onClick={() => setMode('impact')}
          >
            变更影响
          </button>
        </div>
      </header>

      {mode === 'analyze' ? (
        <main className="layout">
          <section className="panel">
            <h2>路由规则</h2>
            <textarea
              className="rule-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={12}
              placeholder={'每行一条：<优先级> <路由模式>\n例如：100 /api/users/:id'}
            />
            <div className="status-line">
              {analyzeError ? (
                <span className="error-text">分析失败：{analyzeError}</span>
              ) : (
                <span>
                  {enabledCount} 条启用规则 · <strong>{conflictCount}</strong> 组冲突
                </span>
              )}
              <button className="btn" onClick={exportJson} disabled={!analysis}>
                导出 JSON
              </button>
            </div>

            {analysis && analysis.rules.length > 0 && (
              <table className="rule-table">
                <thead>
                  <tr>
                    <th>启用</th>
                    <th>ID</th>
                    <th>模式</th>
                    <th>优先级</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.rules.map((rule) => (
                    <tr
                      key={rule.id}
                      className={rule.enabled ? '' : 'row-disabled'}
                      title={rule.error ?? undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={() => toggleRule(rule.index)}
                        />
                      </td>
                      <td className="mono">{rule.id}</td>
                      <td className="mono">
                        {rule.pattern}
                        {rule.error && <div className="error-text">{rule.error}</div>}
                      </td>
                      <td className="mono">{rule.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <h2>冲突对（{conflictCount}）</h2>
            {analysis && conflictCount === 0 && (
              <p className="muted">当前启用规则之间没有发现歧义。</p>
            )}
            <div className="conflict-list">
              {analysis?.conflicts.map((c) => {
                const ra = ruleById.get(c.a);
                const rb = ruleById.get(c.b);
                const winner = c.winner ? ruleById.get(c.winner) : null;
                return (
                  <div className="conflict-card" key={`${c.a}-${c.b}`}>
                    <div className="conflict-head">
                      <span className="badge">{c.a}</span>
                      <span className="mono">{ra?.pattern}</span>
                      <span className="vs">×</span>
                      <span className="badge">{c.b}</span>
                      <span className="mono">{rb?.pattern}</span>
                    </div>
                    <div className="conflict-body">
                      <div>
                        见证路径：<code className="witness">{c.witness}</code>
                      </div>
                      <div>
                        最终命中：
                        {winner ? (
                          <>
                            <span className="badge badge-winner">{winner.id}</span>
                            <span className="mono"> {winner.pattern}</span>
                            <span className="muted">（优先级 {winner.priority}）</span>
                            {!c.winnerInPair && (
                              <span className="warn-text"> ← 被冲突对之外的规则截胡</span>
                            )}
                          </>
                        ) : (
                          <span className="muted">无</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <h2>路径模拟</h2>
            <input
              className="path-input mono"
              value={testPath}
              onChange={(e) => setTestPath(e.target.value)}
              placeholder="/some/request/path"
              spellCheck={false}
            />
            {matchResult && (
              <div className="match-result">
                {matchResult.winner ? (
                  <>
                    <div>
                      <code className="witness">{matchResult.path}</code> 最终命中：
                      <span className="badge badge-winner">{matchResult.winner}</span>
                      <span className="mono">
                        {' '}
                        {ruleById.get(matchResult.winner)?.pattern}
                      </span>
                    </div>
                    {matchResult.matches.length > 1 && (
                      <div className="muted">
                        全部命中（按胜出顺序）：{matchResult.matches.join(' → ')}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="muted">没有规则命中 {matchResult.path}</div>
                )}
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="layout">
          <section className="panel">
            <h2>基线规则（当前规则）</h2>
            <textarea
              className="rule-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder={'每行一条：<优先级> <路由模式>\n例如：100 /api/users/:id'}
            />
            <div className="status-line">
              {impact ? (
                <span className="muted">
                  {baselineStats.enabled} 条启用
                  {baselineStats.errors > 0 && (
                    <span className="error-text"> · {baselineStats.errors} 条非法不参与匹配</span>
                  )}
                  ；启用勾选在「歧义分析」模式调整
                </span>
              ) : (
                <span className="muted">与「歧义分析」共用当前规则及启用状态</span>
              )}
            </div>

            <h2>候选规则</h2>
            <textarea
              className="rule-input"
              value={candidateText}
              onChange={(e) => setCandidateText(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder={'每行一条：<优先级> <路由模式>\n与基线格式相同'}
            />
            {impact && (
              <div className="status-line">
                <span className="muted">
                  {candidateStats.enabled} 条启用
                  {candidateStats.errors > 0 && (
                    <span className="error-text"> · {candidateStats.errors} 条非法不参与匹配</span>
                  )}
                </span>
              </div>
            )}
            {impact && impact.candidateRules.length > 0 && (
              <table className="rule-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>模式</th>
                    <th>优先级</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.candidateRules.map((rule) => (
                    <tr key={rule.id} title={rule.error ?? undefined}>
                      <td className="mono">{rule.id}</td>
                      <td className="mono">
                        {rule.pattern}
                        {rule.error && <div className="error-text">{rule.error}</div>}
                      </td>
                      <td className="mono">{rule.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2>请求样本</h2>
            <textarea
              className="rule-input"
              value={samplesText}
              onChange={(e) => setSamplesText(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder={'每行一个样本：次数 路径（次数省略时为 1）\n例如：120 /api/users/new'}
            />
            {impact && impact.sampleErrors.length > 0 && (
              <div className="sample-errors">
                {impact.sampleErrors.map((e) => (
                  <div className="error-text" key={e.line}>
                    第 {e.line} 行：{e.error}（{e.raw}）
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>影响结果</h2>
            <div className="status-line">
              {impactError ? (
                <span className="error-text">计算失败：{impactError}</span>
              ) : impact ? (
                <span>
                  受影响 <strong>{impact.summary.affectedRequests}</strong> /{' '}
                  {impact.summary.totalRequests} 次请求（{impact.summary.affectedSamples} /{' '}
                  {impact.summary.totalSamples} 条样本）
                  {impact.sampleErrors.length > 0 && (
                    <span className="warn-text">
                      {' '}
                      · {impact.sampleErrors.length} 行非法样本已排除
                    </span>
                  )}
                </span>
              ) : (
                <span className="muted">输入候选规则与样本后自动计算</span>
              )}
              <button className="btn" onClick={exportImpactJson} disabled={!impact}>
                导出影响明细 JSON
              </button>
            </div>

            {impact && (
              <>
                <div className="chip-row">
                  <button
                    className={categoryFilter === 'all' ? 'chip chip-active' : 'chip'}
                    onClick={() => setCategoryFilter('all')}
                  >
                    全部（{impact.summary.totalSamples}）
                  </button>
                  {IMPACT_CATEGORIES.map((c) => (
                    <button
                      key={c.key}
                      className={categoryFilter === c.key ? 'chip chip-active' : 'chip'}
                      onClick={() => setCategoryFilter(c.key)}
                    >
                      {c.label}（{impact.summary.categories[c.key].samples}）
                    </button>
                  ))}
                </div>

                {filteredEntries.length === 0 ? (
                  <p className="muted">该分类下没有样本。</p>
                ) : (
                  <div className="table-scroll">
                    <table className="rule-table impact-table">
                      <thead>
                        <tr>
                          <th>行</th>
                          <th>路径</th>
                          <th>次数</th>
                          <th>基线胜出</th>
                          <th>候选胜出</th>
                          <th>分类</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEntries.map((e) => (
                          <tr key={e.line}>
                            <td className="mono">{e.line}</td>
                            <td className="mono">{e.path}</td>
                            <td className="mono">{e.count}</td>
                            <td>{winnerCell(e.baselineWinner)}</td>
                            <td>{winnerCell(e.candidateWinner)}</td>
                            <td>
                              <span className={`cat-badge cat-${e.category}`}>
                                {categoryLabel(e.category)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
