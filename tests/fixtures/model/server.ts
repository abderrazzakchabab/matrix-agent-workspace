import { createServer } from 'node:http';

const port = Number(process.env.MODEL_FIXTURE_PORT ?? 4010);

interface FixtureCall {
  specialistId: string;
  prompt: string;
  startedAt: number;
  finishedAt: number;
  status: number;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
}

let calls: FixtureCall[] = [];
let responseId = 0;

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        return typeof part.text === 'string' ? part.text : '';
      }
      return '';
    })
    .join('\n');
}

function specialistOf(prompt: string): string {
  if (/repository reader/i.test(prompt)) return 'repo-reader';
  if (/issue reader/i.test(prompt)) return 'issue-reader';
  if (/pull request reader/i.test(prompt)) return 'pr-reader';
  return 'unknown';
}

function priorOf(prompt: string): string {
  const prior = /Prior specialist results[\s\S]*?"specialistId"\s*:\s*"([^"]+)"/.exec(prompt);
  return prior?.[1] ?? 'none';
}

function fixtureOutput(specialistId: string, prompt: string): string {
  const prior = priorOf(prompt);
  switch (specialistId) {
    case 'repo-reader':
      return JSON.stringify({
        summary: `repository fixture prior=${prior}`,
        files: ['README.md', 'src/widget.ts'],
      });
    case 'issue-reader':
      return JSON.stringify({
        summary: `issue fixture prior=${prior}`,
        issues: [{ number: 7, title: 'Cursor issue', state: 'open' }],
      });
    case 'pr-reader':
      return JSON.stringify({
        summary: `pull request fixture prior=${prior}`,
        pullRequests: [{ number: 11, title: 'Safer widget', state: 'open' }],
      });
    default:
      return JSON.stringify({ summary: `unknown fixture prior=${prior}` });
  }
}

function sendCompletion(
  response: import('node:http').ServerResponse,
  request: ChatRequest,
  text: string,
): void {
  const id = `chatcmpl_fixture_${++responseId}`;
  if (request.stream) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 1_786_406_400,
        model: request.model ?? 'fixture-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 1_786_406_400,
        model: request.model ?? 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
    return;
  }
  json(response, 200, {
    id,
    object: 'chat.completion',
    created: 1_786_406_400,
    model: request.model ?? 'fixture-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.local');
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok', fixture: 'model' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__fixture/state') {
    json(response, 200, { calls });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/__fixture/reset') {
    calls = [];
    responseId = 0;
    json(response, 200, { reset: true });
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/openai/chat/completions') {
    json(response, 404, { error: { message: 'model fixture route not found' } });
    return;
  }

  let body: ChatRequest;
  try {
    body = (await readJson(request)) as ChatRequest;
  } catch {
    json(response, 400, { error: { message: 'invalid JSON' } });
    return;
  }
  const prompt = (body.messages ?? []).map((message) => contentText(message.content)).join('\n');
  const specialistId = specialistOf(prompt);
  const startedAt = Date.now();
  const delay = prompt.includes('[fixture:slow]') ? 1_500 : 120;
  await new Promise((resolve) => setTimeout(resolve, delay));

  if (prompt.includes('[fixture:fail-issue]') && specialistId === 'issue-reader') {
    const finishedAt = Date.now();
    calls.push({ specialistId, prompt, startedAt, finishedAt, status: 400 });
    json(response, 400, {
      error: {
        message: 'deterministic issue-reader failure',
        type: 'invalid_request_error',
        code: 'fixture_failure',
      },
    });
    return;
  }

  const finishedAt = Date.now();
  calls.push({ specialistId, prompt, startedAt, finishedAt, status: 200 });
  sendCompletion(response, body, fixtureOutput(specialistId, prompt));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`model fixture listening on ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
