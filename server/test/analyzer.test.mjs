// 针对编译产物 dist/analyzer.js 的断言测试：node test/analyzer.test.mjs
import assert from 'node:assert/strict';
import {
  parsePattern,
  matchSegments,
  intersectionWitness,
  analyze,
  simulate,
  splitPath,
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

console.log('✔ analyzer 全部测试通过');
