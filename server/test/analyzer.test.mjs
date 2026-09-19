// 针对编译产物 dist/analyzer.js 的断言测试：node test/analyzer.test.mjs
import assert from 'node:assert/strict';
import {
  parsePattern,
  matchSegments,
  intersectionWitness,
  analyze,
  simulate,
  splitPath,
  parseSamples,
  impact,
} from '../dist/analyzer.js';

const P = (s) => parsePattern(s);

// ---------- 模式解析 ----------
assert.deepEqual(P('/'), []);
assert.deepEqual(P('/users/:id'), [
  { kind: 'static', value: 'users' },
  { kind: 'param', name: 'id' },
]);
assert.deepEqual(P('/a/*'), [
  { kind: 'static', value: 'a' },
  { kind: 'star' },
]);
assert.throws(() => P('/a/b*c'), /\* 必须单独成段/);
assert.throws(() => P('/a/:'), /缺少名称/);

// ---------- 单规则匹配 ----------
assert.equal(matchSegments(P('/users/:id'), splitPath('/users/42')), true);
assert.equal(matchSegments(P('/users/:id'), splitPath('/users')), false);
assert.equal(matchSegments(P('/users/:id'), splitPath('/users/42/posts')), false);
assert.equal(matchSegments(P('/a/*'), splitPath('/a')), true); // * 匹配零段
assert.equal(matchSegments(P('/a/*'), splitPath('/a/b/c/d')), true);
assert.equal(matchSegments(P('/*'), splitPath('/')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/c')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/x/y/c')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/x/y/d')), false);

// ---------- 求交见证 ----------
const W = (a, b) => {
  const w = intersectionWitness(P(a), P(b));
  return w === null ? null : '/' + w.join('/');
};
assert.equal(W('/users/new', '/users/:id'), '/users/new');
assert.equal(W('/users/:id', '/users/:name'), '/users/x');
assert.equal(W('/a/*', '/*'), '/a'); // 最短：星号都取零段
assert.equal(W('/*', '/a/b'), '/a/b');
assert.equal(W('/:x/b', '/a/:y'), '/a/b');
assert.equal(W('/:x/:y', '/a/*'), '/a/x');
assert.equal(W('/a', '/b'), null); // 无交集
assert.equal(W('/a/:x', '/a/b/c'), null); // 段数对不上且无星号
assert.equal(W('/a/*/d', '/a/b/*'), '/a/b/d'); // 双星号求交
assert.equal(W('/', '/*'), '/'); // 根路径与通配

// 见证必须真的同时命中两条规则
for (const [a, b] of [
  ['/api/:version/users', '/api/v1/*'],
  ['/*/health', '/internal/*'],
  ['/:a/:b/:c', '/x/*/:z'],
]) {
  const w = intersectionWitness(P(a), P(b));
  assert.ok(w !== null, `${a} 与 ${b} 应有交集`);
  assert.ok(matchSegments(P(a), w) && matchSegments(P(b), w), `见证须同时命中 ${a}、${b}`);
}

// ---------- 整体分析：优先级与禁用 ----------
const rules = [
  { pattern: '/api/users/new', priority: 5, enabled: true },
  { pattern: '/api/users/:id', priority: 10, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/health', priority: 0, enabled: true },
];
const result = analyze(rules);
assert.equal(result.rules.length, 4);
assert.deepEqual(result.rules.map((r) => r.id), ['R1', 'R2', 'R3', 'R4']);
// R1∩R2 见证 /api/users/new，R2 优先级 10 > 5，胜出 R2
const c12 = result.conflicts.find((c) => c.a === 'R1' && c.b === 'R2');
assert.equal(c12.witness, '/api/users/new');
assert.equal(c12.winner, 'R2');
assert.equal(c12.winnerInPair, true);
// R1∩R3 见证 /api/users/new 也被 R2 命中，R2 优先级最高故胜出；R2∩R3 的胜出者是 R2
assert.equal(result.conflicts.find((c) => c.a === 'R1' && c.b === 'R3').winner, 'R2');
assert.equal(result.conflicts.find((c) => c.a === 'R2' && c.b === 'R3').winner, 'R2');
assert.equal(result.conflicts.length, 3);

// 禁用 R2 后重算：/api/users/new 的胜出者变为 R1
const disabled = analyze(rules.map((r, i) => (i === 1 ? { ...r, enabled: false } : r)));
assert.ok(!disabled.conflicts.some((c) => c.a === 'R2' || c.b === 'R2'));
assert.equal(disabled.conflicts.find((c) => c.a === 'R1' && c.b === 'R3').winner, 'R1');

// 平手按输入顺序：先出现者胜
const tie = analyze([
  { pattern: '/a/:x', priority: 3, enabled: true },
  { pattern: '/a/:y', priority: 3, enabled: true },
]);
assert.equal(tie.conflicts[0].winner, 'R1');

// 见证路径的胜出者可能是冲突对之外的第三方高优先级规则
const third = analyze([
  { pattern: '/:x/b', priority: 1, enabled: true },
  { pattern: '/a/:y', priority: 1, enabled: true },
  { pattern: '/a/b', priority: 10, enabled: true },
]);
const c12t = third.conflicts.find((c) => c.a === 'R1' && c.b === 'R2');
assert.equal(c12t.witness, '/a/b');
assert.equal(c12t.winner, 'R3'); // 第三方精确规则以更高优先级截胡
assert.equal(c12t.winnerInPair, false);

// ---------- 路径模拟 ----------
const sim = simulate(rules, '/api/users/new');
assert.equal(sim.winner, 'R2');
assert.deepEqual(sim.matches, ['R2', 'R1', 'R3']);
assert.equal(simulate(rules, '/nope').winner, null);
assert.equal(simulate(rules, '/health').winner, 'R4');

// ---------- 样本解析 ----------
{
  const { samples, errors } = parseSamples('10 /a\n/b\n# 注释\n\n3 /c/d');
  assert.equal(errors.length, 0);
  assert.deepEqual(samples, [
    { line: 1, path: '/a', count: 10 },
    { line: 2, path: '/b', count: 1 },
    { line: 5, path: '/c/d', count: 3 },
  ]);
}
{
  // 非法样本逐行报错且不产生样本
  const { samples, errors } = parseSamples(
    ['0 /a', '-2 /a', '3.5 /a', '5', '/a b c', 'no-slash', 'x /a'].join('\n'),
  );
  assert.equal(samples.length, 0);
  assert.deepEqual(
    errors.map((e) => e.line),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.match(errors[0].error, /正整数/);
  assert.match(errors[2].error, /正整数/);
  assert.match(errors[3].error, /缺少路径/);
  assert.match(errors[4].error, /格式非法/);
  assert.match(errors[5].error, /须以 \/ 开头/);
}
{
  // 路径规范化：多余斜杠被去掉
  const { samples } = parseSamples('2 //api//users/');
  assert.equal(samples[0].path, '/api/users');
}

// ---------- 变更影响分类 ----------
const baseRules = [
  { pattern: '/api/users/:id', priority: 5, enabled: true },
  { pattern: '/api/users/new', priority: 90, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/health', priority: 0, enabled: true },
];
const candRules = [
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/api/users/:id', priority: 5, enabled: true }, // 与基线 R1 同规则（位置无关）
  { pattern: '/healthz', priority: 0, enabled: true },
];
{
  const r = impact(
    baseRules,
    candRules,
    [
      '10 /api/users/42', // 两侧同为 /api/users/:id(5) → 无变化
      '5  /api/users/new', // 基线 R2(90) → 候选 :id(5) → 命中迁移
      '3  /health', // 候选无命中 → 变为未命中
      '2  /healthz', // 基线无命中 → 新增命中
      '7  /nowhere', // 两侧均未命中 → 无变化
      'bad-line', // 非法样本：逐行提示且不参与统计
    ].join('\n'),
  );
  assert.equal(r.sampleErrors.length, 1);
  assert.equal(r.sampleErrors[0].line, 6);
  assert.equal(r.entries.length, 5);
  const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e]));
  assert.equal(byPath['/api/users/42'].category, 'unchanged');
  assert.equal(byPath['/api/users/42'].baselineWinner.id, 'R1');
  assert.equal(byPath['/api/users/42'].candidateWinner.id, 'R2'); // 候选中位置不同仍算同规则
  assert.equal(byPath['/api/users/new'].category, 'migrated');
  assert.equal(byPath['/api/users/new'].baselineWinner.pattern, '/api/users/new');
  assert.equal(byPath['/api/users/new'].candidateWinner.pattern, '/api/users/:id');
  assert.equal(byPath['/health'].category, 'became-unmatched');
  assert.equal(byPath['/health'].candidateWinner, null);
  assert.equal(byPath['/healthz'].category, 'new-hit');
  assert.equal(byPath['/healthz'].baselineWinner, null);
  assert.equal(byPath['/nowhere'].category, 'unchanged');
  // 汇总请求次数
  assert.equal(r.summary.totalSamples, 5);
  assert.equal(r.summary.totalRequests, 27);
  assert.equal(r.summary.affectedSamples, 3);
  assert.equal(r.summary.affectedRequests, 10); // 5 + 3 + 2
  assert.equal(r.summary.categories.migrated.requests, 5);
  assert.equal(r.summary.categories['new-hit'].requests, 2);
  assert.equal(r.summary.categories['became-unmatched'].requests, 3);
  assert.equal(r.summary.categories.unchanged.requests, 17);
}
{
  // 同一规则判定：规范化模式 + 优先级均相同才算同一规则
  const same = impact(
    [{ pattern: '/a//b/', priority: 5, enabled: true }],
    [{ pattern: '/a/b', priority: 5, enabled: true }],
    '/a/b',
  );
  assert.equal(same.entries[0].category, 'unchanged'); // 规范化后相同
  const diffPrio = impact(
    [{ pattern: '/a/b', priority: 5, enabled: true }],
    [{ pattern: '/a/b', priority: 6, enabled: true }],
    '/a/b',
  );
  assert.equal(diffPrio.entries[0].category, 'migrated'); // 优先级不同 → 命中迁移
}
{
  // 禁用与非法规则不参与匹配；非法规则在结果中带 error
  const r = impact(
    [
      { pattern: '/a', priority: 5, enabled: false },
      { pattern: '/b*c', priority: 1, enabled: true },
    ],
    [],
    '/a',
  );
  assert.equal(r.entries[0].category, 'unchanged'); // 双方都未命中
  assert.ok(r.baselineRules[1].error);
  assert.equal(r.candidateRules.length, 0);
}

console.log('✔ analyzer 全部测试通过');
