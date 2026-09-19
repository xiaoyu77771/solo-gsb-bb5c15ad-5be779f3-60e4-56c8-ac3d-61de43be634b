import express, { Request, Response } from 'express';
import path from 'path';
import { analyze, simulate, RuleInput } from './analyzer';

const app = express();
app.use(express.json({ limit: '1mb' }));

const MAX_RULES = 500;
const MAX_PATTERN_LEN = 500;

/** 清洗客户端提交的单条规则，返回安全的 RuleInput。 */
function sanitizeRule(raw: unknown): RuleInput | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pattern !== 'string') return null;
  const pattern = obj.pattern.slice(0, MAX_PATTERN_LEN);
  const priority =
    typeof obj.priority === 'number' && Number.isFinite(obj.priority) ? obj.priority : 0;
  const enabled = obj.enabled !== false;
  return { pattern, priority, enabled };
}

function sanitizeRules(body: unknown): RuleInput[] | null {
  if (body === null || typeof body !== 'object') return null;
  const rules = (body as Record<string, unknown>).rules;
  if (!Array.isArray(rules) || rules.length > MAX_RULES) return null;
  const out: RuleInput[] = [];
  for (const raw of rules) {
    const rule = sanitizeRule(raw);
    if (!rule) return null;
    out.push(rule);
  }
  return out;
}

app.post('/api/analyze', (req: Request, res: Response) => {
  const rules = sanitizeRules(req.body);
  if (!rules) {
    res.status(400).json({ error: `请求非法：需要 rules 数组（至多 ${MAX_RULES} 条）` });
    return;
  }
  res.json(analyze(rules));
});

app.post('/api/match', (req: Request, res: Response) => {
  const rules = sanitizeRules(req.body);
  const pathInput = (req.body as Record<string, unknown>)?.path;
  if (!rules || typeof pathInput !== 'string' || pathInput.length > 2000) {
    res.status(400).json({ error: '请求非法：需要 rules 数组和 path 字符串' });
    return;
  }
  res.json(simulate(rules, pathInput));
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// 生产模式下由 Express 直接托管前端构建产物
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`route-ambiguity-analyzer listening on http://0.0.0.0:${port}`);
});
