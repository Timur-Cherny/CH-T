#!/usr/bin/env node
/**
 * MCP-сервер Kafka ЛОКАЛЬНОГО стенда — ТОЛЬКО ЧТЕНИЕ.
 *
 * Работает через `kubectl exec` в под Kafka: CLI уже лежат в образе, поэтому
 * не нужен ни клиентская библиотека, ни port-forward, который надо сторожить.
 *
 * Границы жёсткие и намеренные:
 *   - адрес пода и кластера зашиты на стенд, сменить их вызовом нельзя;
 *   - список разрешённых бинарников — белый (ALLOWED), в нём нет ни
 *     kafka-console-producer, ни kafka-topics --create/--delete;
 *   - аргументы каждого инструмента собираются здесь, а не приходят строкой:
 *     передать «свою» команду через параметры невозможно.
 *
 * Прод не обслуживается: bootstrap всегда localhost:9092 внутри пода стенда.
 */

import { execFile, spawn } from 'node:child_process';

const CONTEXT = 'colima';
const NAMESPACE = 'lms-local';
const BOOTSTRAP = 'localhost:9092';

// Белый список утилит.
//
// Запись (kafka-console-producer) разрешена — решение владельца «писать
// можно, но в локальный только». Она безопасна не по дисциплине вызывающего,
// а по конструкции: CONTEXT, NAMESPACE и BOOTSTRAP выше — константы, адрес
// параметром не подменить, дотянуться этим сервером до прода нельзя.
//
// Если адрес когда-нибудь станет параметром, запись отсюда убрать в тот же
// коммит: тогда единственная защита исчезнет.
//
// kafka-acls, kafka-configs --alter и удаление топиков в список НЕ входят:
// «писать сообщения» и «менять устройство кластера» — разные права.
const ALLOWED = new Set([
  'kafka-topics',
  'kafka-consumer-groups',
  'kafka-console-consumer',
  'kafka-get-offsets',
  'kafka-console-producer',
]);

const MAX_OUTPUT = 20000;

const run = (args, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    execFile(
      'kubectl',
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });

let podCache = null;

const kafkaPod = async () => {
  if (podCache) return podCache;

  const out = await run([
    '--context', CONTEXT, '-n', NAMESPACE,
    'get', 'pods', '-l', 'app=kafka',
    '--field-selector', 'status.phase=Running',
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);

  const pod = out.trim();
  if (!pod) throw new Error('в namespace нет запущенного пода с меткой app=kafka');

  podCache = pod;
  return pod;
};

/** Единственный путь к Kafka. Бинарник сверяется с белым списком. */
const kafka = async (binary, args, timeoutMs) => {
  if (!ALLOWED.has(binary)) {
    throw new Error(`утилита вне белого списка: ${binary}`);
  }

  const pod = await kafkaPod();
  // CLI — JVM и делит лимит контейнера с самим брокером (на стенде 768Mi).
  // С дефолтной кучей вызов выбивает под за лимит и брокера убивает OOMKilled.
  const out = await run(
    ['--context', CONTEXT, '-n', NAMESPACE, 'exec', pod, '--',
     'env', 'KAFKA_HEAP_OPTS=-Xmx96m -Xms32m',
     binary, '--bootstrap-server', BOOTSTRAP, ...args],
    timeoutMs
  );

  return out.length > MAX_OUTPUT
    ? `${out.slice(0, MAX_OUTPUT)}\n\n[…срезано, всего ${out.length} символов]`
    : out;
};

/**
 * Отправка идёт через stdin, а не через `sh -c`: тело сообщения приходит
 * извне, и склеивать его в командную строку — это приглашение к подстановке.
 * spawn с массивом аргументов такой возможности не оставляет.
 */
const kafkaProduce = async (topic, lines, timeoutMs = 30000) => {
  const pod = await kafkaPod();

  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      ['--context', CONTEXT, '-n', NAMESPACE, 'exec', '-i', pod, '--',
       'kafka-console-producer', '--bootstrap-server', BOOTSTRAP,
       '--topic', topic, '--property', 'parse.key=true',
       '--property', 'key.separator=\t'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`producer не завершился за ${timeoutMs} мс`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(lines.length);
      else reject(new Error(stderr.trim() || `producer вышел с кодом ${code}`));
    });

    child.stdin.end(`${lines.join('\n')}\n`);
  });
};

const TOOLS = [
  {
    name: 'kafka_topics',
    description: 'Список топиков стенда.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const out = await kafka('kafka-topics', ['--list']);
      return out.split('\n').map((t) => t.trim()).filter(Boolean);
    },
  },
  {
    name: 'kafka_topic_describe',
    description: 'Партиции, лидеры и реплики топика.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Имя топика' } },
      required: ['topic'],
    },
    handler: ({ topic }) =>
      kafka('kafka-topics', ['--describe', '--topic', String(topic)]),
  },
  {
    name: 'kafka_groups',
    description: 'Список консьюмер-групп.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const out = await kafka('kafka-consumer-groups', ['--list']);
      return out.split('\n').map((g) => g.trim()).filter(Boolean);
    },
  },
  {
    name: 'kafka_group_lag',
    description:
      'Отставание группы по партициям: текущий офсет, конец лога, лаг. Главный признак, что потребитель не справляется.',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', description: 'Имя группы' } },
      required: ['group'],
    },
    handler: ({ group }) =>
      kafka('kafka-consumer-groups', ['--describe', '--group', String(group)]),
  },
  {
    name: 'kafka_peek',
    description:
      'Прочитать последние сообщения топика, не трогая офсеты живых групп (отдельная временная группа, --from-beginning не используется).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Имя топика' },
        limit: { type: 'number', description: 'Сколько сообщений, по умолчанию 10, максимум 100' },
        timeoutMs: { type: 'number', description: 'Сколько ждать, по умолчанию 8000' },
      },
      required: ['topic'],
    },
    handler: async ({ topic, limit, timeoutMs }) => {
      const max = Math.min(Math.max(Number(limit) || 10, 1), 100);
      const wait = Math.min(Math.max(Number(timeoutMs) || 8000, 1000), 30000);

      // --max-messages и таймаут обязательны: без них консьюмер висит вечно и
      // держит exec открытым. Смещения читаются с конца — прошлое не поднимаем.
      return kafka(
        'kafka-console-consumer',
        [
          '--topic', String(topic),
          '--max-messages', String(max),
          '--timeout-ms', String(wait),
          '--property', 'print.timestamp=true',
          '--property', 'print.key=true',
        ],
        wait + 15000
      );
    },
  },
  {
    name: 'kafka_produce',
    description:
      'Отправить сообщения в топик СТЕНДА. Ключ необязателен. Адрес кластера зашит в сервер — отправить куда-то ещё нельзя.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Имя топика' },
        messages: {
          type: 'array',
          description: 'Сообщения: строка (тело) либо {key, value}. До 500 за вызов.',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['value'],
              },
            ],
          },
        },
      },
      required: ['topic', 'messages'],
    },
    handler: async ({ topic, messages }) => {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages должен быть непустым массивом');
      }
      if (messages.length > 500) {
        throw new Error(`за вызов не больше 500 сообщений, передано ${messages.length}`);
      }

      // Перевод строки внутри тела разорвал бы сообщение надвое: console-producer
      // читает построчно. Отвергаем явно, а не портим данные молча.
      const lines = messages.map((message, index) => {
        const key = typeof message === 'object' && message ? (message.key ?? '') : '';
        const value = typeof message === 'object' && message ? message.value : String(message);

        if (typeof value !== 'string') {
          throw new Error(`сообщение ${index}: value должен быть строкой`);
        }
        if (value.includes('\n') || String(key).includes('\n')) {
          throw new Error(
            `сообщение ${index}: перенос строки внутри ключа или тела — console-producer читает построчно и разорвёт его`
          );
        }

        return `${key}\t${value}`;
      });

      const sent = await kafkaProduce(String(topic), lines);

      return { topic, sent, cluster: `${CONTEXT}/${NAMESPACE}` };
    },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = async (request) => {
  const { method, params } = request;

  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'kafka-stand', version: '1.0.0' },
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
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
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

    // Уведомления ответа не требуют.
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
