/**
 * DSH 孤儿进程清理器 —— Host 半。
 *
 * 职责：
 * 1. 扫描本机进程树，找出「父进程已死、自己还活着」的遗留进程（主要来源是 DSH 重启后
 *    没被回收的 MCP stdio 连接器，以及忘记关的 dev server）。
 * 2. 给界面和 Agent 提供同一套扫描 / 清理能力，不存在两套逻辑。
 * 3. 启动时自动扫一次，有残留就能在按钮上直接看到角标。
 *
 * 安全边界（宁可漏杀，不可误杀）：
 *   - 只处理父链断裂的进程，父链正常的（包括当前 Host 及其全部后代）不进视野；
 *   - 系统进程、桌面壳、当前 Host 祖先链一律不碰；
 *   - 执行清理前重新扫描一次做二次校验，pid 复用导致的错杀会被这一层挡掉。
 */

import { analyze, scan } from './lib/scanner.js';
import { killPids } from './lib/killer.js';

export const name = 'dsh-orphan-cleaner';
export const inject = ['webServer', 'tools'];

const ROUTE_PREFIX = '/orphan-cleaner';
/** 扫描结果缓存：界面连点刷新时不必每次都起 PowerShell。 */
const CACHE_TTL = 2000;
/** 启动后多久做第一次自动扫描（等 Host / MCP 连接都稳定下来）。 */
const AUTO_SCAN_DELAY = 8000;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > 256 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象');
  return value;
}

function explanation(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 防 CSRF：浏览器跨站请求一定带 Origin / Sec-Fetch-Site，拒绝；
 * 本地工具（curl / 脚本 / Agent）两者都没有，放行。
 * 这条清理接口能杀进程，必须挡住恶意网页的跨站 POST。
 */
function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  }
  return false;
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function formatAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function formatClock(iso) {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const pad = value => String(value).padStart(2, '0');
  const sameDay = date.toDateString() === new Date().toDateString();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? clock : `${date.getMonth() + 1}-${pad(date.getDate())} ${clock}`;
}

/** 给 Agent 工具用的纯文本摘要。 */
function reportToText(report) {
  const { summary, groups } = report;
  const listed = groups;
  if (listed.length === 0) {
    return `扫描了 ${report.totalProcesses} 个进程，没有发现孤儿进程。`;
  }

  const lines = [
    `扫描 ${report.totalProcesses} 个进程，发现 ${summary.groupCount} 组父链断裂的进程：高置信 ${summary.highGroupCount} 组 / ${summary.highProcessCount} 个进程 / ${formatBytes(summary.highBytes)}，其余 ${summary.otherGroupCount} 组 / ${formatBytes(summary.otherBytes)}。`,
    '只有「高置信」组值得清理；其余多为启动器已退出但程序仍在运行，属正常现象。',
    '',
  ];

  for (const group of listed) {
    const tag = group.blocked
      ? '[受保护]'
      : group.high
        ? '[高置信]'
        : group.interactive
          ? '[运行中·大概率正常]'
          : '[待确认]';
    const ports = group.ports.length ? ` · 占用端口 ${group.ports.join(',')}` : '';
    lines.push(`${tag} ${group.label}`);
    lines.push(
      `  ${group.processCount} 个进程 / ${formatBytes(group.totalWs)} / 创建于 ${formatClock(group.createdAt)}（已 ${formatAge(group.ageMs)}）${ports}`,
    );
    lines.push(`  ${group.members.map(m => `${m.name}(${m.pid})`).join(' ')}`);
    lines.push('');
  }

  lines.push('清理方式：调用 orphan_kill 只清高置信（{ "onlyHigh": true }），或指定 { "groupIds": ["g12345"] }。');
  return lines.join('\n');
}

export function apply(ctx) {
  /** @type {{at: number, report: any} | null} */
  let cache = null;
  /** 启动时那次自动扫描的摘要，供界面显示角标。 */
  let autoScan = null;
  let lastKill = null;

  async function getReport({ force = false } = {}) {
    if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache.report;
    const report = await scan();
    cache = { at: Date.now(), report };
    return report;
  }

  /**
   * 执行清理。
   * 不论调用方传了什么，都先重新扫一次：只在「刚刚确认仍是孤儿」的进程上动手。
   */
  async function runKill({ groupIds = [], pids = [], onlyHigh = false } = {}) {
    const fresh = await getReport({ force: true });

    const wantedGroups = new Set(Array.isArray(groupIds) ? groupIds.map(String) : []);
    const selected = fresh.groups.filter(group => {
      if (group.blocked) return false;
      if (onlyHigh) return group.high;
      if (wantedGroups.size > 0) return wantedGroups.has(group.id);
      return false;
    });

    const explicit = new Set((Array.isArray(pids) ? pids : []).map(Number).filter(Number.isInteger));
    const targets = new Map();
    for (const group of selected) {
      for (const member of group.members) targets.set(member.pid, group);
    }
    for (const pid of explicit) {
      if (targets.has(pid)) continue;
      const owner = fresh.groups.find(group => group.members.some(m => m.pid === pid));
      if (owner && !owner.blocked) targets.set(pid, owner);
    }

    if (targets.size === 0) {
      return {
        ok: true,
        requested: 0,
        killed: [],
        failed: [],
        skipped: [],
        before: fresh.summary,
        after: fresh.summary,
        message: '没有匹配到可清理的孤儿进程。',
      };
    }

    const result = await killPids([...targets.keys()]);

    // 清理后再扫一次，把真实释放量报给用户。
    const after = await getReport({ force: true });
    lastKill = {
      at: Date.now(),
      killed: result.killed.length,
      failed: result.failed.length,
      freedBytes: fresh.groups
        .filter(group => group.members.some(m => targets.has(m.pid)))
        .reduce((sum, group) => sum + group.totalWs, 0),
    };

    return {
      ok: result.ok,
      requested: result.requested,
      killed: result.killed,
      failed: result.failed,
      skipped: [],
      freedBytes: lastKill.freedBytes,
      before: fresh.summary,
      after: after.summary,
      message:
        result.failed.length === 0
          ? `已终止 ${result.killed.length} 个进程，释放约 ${formatBytes(lastKill.freedBytes)}。`
          : `已终止 ${result.killed.length} 个进程，${result.failed.length} 个失败。`,
    };
  }

  // ---- HTTP 路由：界面用 ----

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local');
        const route = url.pathname.replace(/^\/orphan-cleaner\/?/u, '').replace(/\/$/u, '');
        try {
          if (isCrossSite(req)) {
            sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
            return;
          }

          if (route === 'state' && req.method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              value: {
                auto: autoScan ? { at: autoScan.at, summary: autoScan.summary, groups: autoScan.groups.length } : null,
                lastKill,
                cached: cache ? { at: cache.at, summary: cache.report.summary } : null,
              },
            });
            return;
          }

          if (route === 'scan' && req.method === 'GET') {
            const force = url.searchParams.get('force') === '1';
            sendJson(res, 200, { ok: true, value: await getReport({ force }) });
            return;
          }

          if (route === 'kill' && req.method === 'POST') {
            const body = await readJson(req);
            sendJson(res, 200, {
              ok: true,
              value: await runKill({
                groupIds: body.groupIds,
                pids: body.pids,
                onlyHigh: body.onlyHigh === true,
              }),
            });
            return;
          }

          sendJson(res, 404, { ok: false, error: `未知的接口 ${route || '/'}` });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: explanation(error) });
        }
      },
    });
    return () => dispose();
  }, 'dsh-orphan-cleaner: HTTP 路由');

  // ---- Agent 工具：会话里直接问「有没有孤儿」 ----

  ctx.effect(() => {
    const disposers = [];

    disposers.push(
      ctx.tools.register({
        name: 'orphan_scan',
        description:
          '扫描本机的孤儿进程（父进程已退出、自己还活着的遗留进程），主要是 DSH 重启后没被回收的 MCP stdio 连接器' +
          '（npx / mcp-server-mysql / redis-mcp / ssh-mcp 等）和忘记关闭的 dev server（vite / node server.js）。' +
          '返回按「进程组」聚合的结果，含内存占用、创建时间、占用端口。用户问「有没有孤儿进程」「内存被谁吃了」「为什么越用越卡」时先调这个。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }];
          },
        },
        async execute() {
          return { text: reportToText(await getReport({ force: true })) };
        },
      }),
    );

    disposers.push(
      ctx.tools.register({
        name: 'orphan_kill',
        description:
          '终止孤儿进程（整棵进程树强杀）。默认只清理「高置信」组：命令行明确是 MCP 连接器或 dev server 的遗留进程。' +
          '清理前会重新扫描做二次校验，父链正常的进程、系统进程、当前 DSH 自身都不会被碰到。' +
          '不传参数等价于 onlyHigh=true。需要精确指定时用 groupIds（来自 orphan_scan 的组 id）。',
        parameters: {
          type: 'object',
          properties: {
            onlyHigh: { type: 'boolean', description: '只清理高置信组，默认 true。' },
            groupIds: {
              type: 'array',
              items: { type: 'string' },
              description: '指定要清理的组 id（orphan_scan 返回的 id），给了就不再按 onlyHigh 全选。',
            },
            pids: {
              type: 'array',
              items: { type: 'number' },
              description: '精确指定要终止的 pid（必须仍属于某个孤儿组，否则跳过）。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.text ?? '') }];
          },
        },
        async execute(args) {
          const hasGroups = Array.isArray(args?.groupIds) && args.groupIds.length > 0;
          const hasPids = Array.isArray(args?.pids) && args.pids.length > 0;
          const onlyHigh = args?.onlyHigh === undefined ? !hasGroups && !hasPids : args.onlyHigh === true;
          const result = await runKill({
            onlyHigh: onlyHigh && !hasGroups && !hasPids,
            groupIds: args?.groupIds,
            pids: args?.pids,
          });
          const lines = [result.message];
          if (result.failed.length > 0) {
            lines.push('失败明细：');
            for (const item of result.failed) lines.push(`  pid ${item.pid}: ${item.error}`);
          }
          lines.push(
            `清理前：高置信 ${result.before.highProcessCount} 个进程 / ${formatBytes(result.before.highBytes)}；` +
              `清理后：${result.after.highProcessCount} 个 / ${formatBytes(result.after.highBytes)}。`,
          );
          return { text: lines.join('\n') };
        },
      }),
    );

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          // 卸载失败不该阻断其它插件的清理。
        }
      }
    };
  }, 'dsh-orphan-cleaner: Agent 工具');

  // ---- 启动后自动扫一次，让界面一打开就能看到角标 ----

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const report = await getReport({ force: true });
          autoScan = { at: Date.now(), summary: report.summary, groups: report.groups };
          if (report.summary.highProcessCount > 0) {
            console.log(
              `[dsh-orphan-cleaner] 启动扫描：发现 ${report.summary.highGroupCount} 组高置信孤儿，共 ${report.summary.highProcessCount} 个进程 / ${formatBytes(report.summary.highBytes)}`,
            );
          }
        } catch (error) {
          console.warn('[dsh-orphan-cleaner] 启动扫描失败：', explanation(error));
        }
      })();
    }, AUTO_SCAN_DELAY);
    return () => clearTimeout(timer);
  }, 'dsh-orphan-cleaner: 启动自动扫描');
}

/** 供测试 / 外部复用。 */
export { analyze, scan };
