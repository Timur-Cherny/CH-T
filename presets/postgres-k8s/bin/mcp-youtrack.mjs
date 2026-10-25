#!/usr/bin/env node
/**
 * MCP-сервер YouTrack — ТОЛЬКО ЧТЕНИЕ.
 *
 * YouTrack не умеет read-only токены: постоянный токен наследует все права
 * учётки, включая запись. Поэтому ограничение живёт здесь: единственный способ
 * сходить в сеть — функция get() ниже, она жёстко шлёт GET. Инструментов,
 * меняющих данные, в списке нет, и добавлять их сюда не следует — для записи
 * заводить отдельный сервер с отдельным осознанным решением.
 *
 * Транспорт — stdio, JSON-RPC построчно. Зависимостей нет намеренно: сервер
 * должен подниматься без npm install, как и соседняя обёртка pg-stand.
 */

const BASE = (process.env.YOUTRACK_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.YOUTRACK_TOKEN || '';

if (!BASE || !TOKEN) {
  process.stderr.write(
    'mcp-youtrack: нужны YOUTRACK_URL и YOUTRACK_TOKEN в окружении\n'
  );
  process.exit(1);
}

// Описания задач бывают на десятки килобайт. Полный текст вытеснит из контекста
// то, ради чего задачу и открывали, поэтому режем и говорим, что срезали.
const MAX_TEXT = 4000;

const clip = (text) => {
  if (typeof text !== 'string' || text.length <= MAX_TEXT) return text ?? null;

  return `${text.slice(0, MAX_TEXT)}\n\n[…срезано, всего ${text.length} символов]`;
};

const get = async (path, params = {}) => {
  const url = new URL(`${BASE}/api/${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Тело ошибки YouTrack токена не содержит, но URL может нести query —
    // отдаём только код и первые строки, чтобы ничего лишнего не утекло в лог.
    throw new Error(
      `YouTrack ${response.status} ${response.statusText}: ${body.slice(0, 300)}`
    );
  }

  return response.json();
};

const ISSUE_FIELDS =
  'idReadable,summary,description,created,updated,' +
  'reporter(login,fullName),updater(login,fullName),' +
  'customFields(name,value(name,login,fullName,text,presentation))';

const LINK_FIELDS =
  'linkType(name,sourceToTarget,targetToSource),direction,' +
  `issues(${ISSUE_FIELDS})`;

const shapeIssue = (issue) => ({
  id: issue.idReadable,
  summary: issue.summary,
  description: clip(issue.description),
  created: issue.created ? new Date(issue.created).toISOString() : null,
  updated: issue.updated ? new Date(issue.updated).toISOString() : null,
  reporter: issue.reporter?.fullName ?? issue.reporter?.login ?? null,
  fields: Object.fromEntries(
    (issue.customFields ?? [])
      .map((field) => {
        const raw = field.value;
        const value = Array.isArray(raw)
          ? raw.map((v) => v?.name ?? v?.fullName ?? v?.login ?? v).join(', ')
          : (raw?.name ?? raw?.fullName ?? raw?.login ?? raw?.text ?? raw);

        return [field.name, value ?? null];
      })
      .filter(([, value]) => value !== null && value !== '')
  ),
});

const TOOLS = [
  {
    name: 'youtrack_issue',
    description:
      'Прочитать одну задачу YouTrack по номеру (например ABC-123): заголовок, описание, поля, автор, даты.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Номер задачи, например ABC-123' },
      },
      required: ['id'],
    },
    handler: async ({ id }) =>
      shapeIssue(await get(`issues/${encodeURIComponent(id)}`, { fields: ISSUE_FIELDS })),
  },
  {
    name: 'youtrack_children',
    description:
      'Связанные задачи: дети эпика, подзадачи, зависимости. Возвращает группы по типу связи.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Номер задачи-родителя' },
      },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const links = await get(`issues/${encodeURIComponent(id)}/links`, {
        fields: LINK_FIELDS,
      });

      return links
        .filter((link) => link.issues?.length)
        .map((link) => ({
          link:
            link.direction === 'INWARD'
              ? link.linkType?.targetToSource
              : link.linkType?.sourceToTarget,
          issues: link.issues.map(shapeIssue),
        }));
    },
  },
  {
    name: 'youtrack_search',
    description:
      'Поиск задач языком запросов YouTrack, например "project: MD Assignee: me #Unresolved".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Запрос на языке YouTrack' },
        limit: { type: 'number', description: 'Сколько вернуть, по умолчанию 30' },
      },
      required: ['query'],
    },
    handler: async ({ query, limit }) => {
      const issues = await get('issues', {
        query,
        fields: ISSUE_FIELDS,
        $top: Math.min(Number(limit) || 30, 200),
      });

      return issues.map(shapeIssue);
    },
  },
  {
    name: 'youtrack_article',
    description:
      'Прочитать статью базы знаний по номеру (например MD-A-199) — туда задачи ссылаются за ТЗ. Возвращает текст статьи и список её подстатей.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Номер статьи, например MD-A-199' },
        full: {
          type: 'boolean',
          description:
            'Отдать текст целиком без обрезки. ТЗ бывают длинными — включать осознанно.',
        },
      },
      required: ['id'],
    },
    handler: async ({ id, full }) => {
      const article = await get(`articles/${encodeURIComponent(id)}`, {
        fields:
          'idReadable,summary,content,created,updated,' +
          'reporter(login,fullName),childArticles(idReadable,summary)',
      });

      return {
        id: article.idReadable,
        summary: article.summary,
        content: full ? (article.content ?? null) : clip(article.content),
        length: article.content?.length ?? 0,
        updated: article.updated ? new Date(article.updated).toISOString() : null,
        author: article.reporter?.fullName ?? article.reporter?.login ?? null,
        children: (article.childArticles ?? []).map((child) => ({
          id: child.idReadable,
          summary: child.summary,
        })),
      };
    },
  },
  {
    name: 'youtrack_comments',
    description: 'Комментарии к задаче: автор, дата, текст.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Номер задачи' },
      },
      required: ['id'],
    },
    handler: async ({ id }) => {
      const comments = await get(`issues/${encodeURIComponent(id)}/comments`, {
        fields: 'created,author(login,fullName),text',
      });

      return comments.map((comment) => ({
        author: comment.author?.fullName ?? comment.author?.login ?? null,
        created: comment.created ? new Date(comment.created).toISOString() : null,
        text: clip(comment.text),
      }));
    },
  },
];

const send = (message) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = async (request) => {
  const { id, method, params } = request;

  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'youtrack', version: '1.0.0' },
    };
  }

  if (method === 'tools/list') {
    return {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    };
  }

  if (method === 'tools/call') {
    const tool = TOOLS.find((candidate) => candidate.name === params?.name);

    if (!tool) throw new Error(`нет такого инструмента: ${params?.name}`);

    const result = await tool.handler(params.arguments ?? {});

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  throw new Error(`метод не поддерживается: ${method}`);
};

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);

    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    // Уведомления ответа не требуют — молча пропускаем, иначе клиент получит
    // ответ на сообщение без id и разорвёт сессию.
    if (request.id === undefined) continue;

    try {
      send({ jsonrpc: '2.0', id: request.id, result: await handle(request) });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: String(error?.message ?? error) },
      });
    }
  }
});
