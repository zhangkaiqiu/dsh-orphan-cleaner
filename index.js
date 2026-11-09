/**
 * DSH 孤儿进程清理器 —— Host 半。
 *
 * 职责：
 * 1. 扫描本机进程树，找出「父进程已死、自己还活着」的遗留进程（主要来源是 DSH 重启后
 *    没被回收的 MCP stdio 连接器，以及忘记关的 dev server）。
 * 2. 界面与服务端共用同一套扫描 / 清理逻辑，不存在两套实现。
 * 3. 启动时自动扫一次，有残留就能在按钮上直接看到角标。
 *
 * 安全边界（宁可漏杀，不可误杀）：
 *   - 只处理父链断裂的进程，父链正常的（包括当前 Host 及其全部后代）不进视野；
 *   - 系统进程、桌面壳、当前 Host 祖先链一律不碰；
 *   - 执行清理前重新扫描一次做二次校验，pid 复用导致的错杀会被这一层挡掉。
 */

import { scan } from './lib/scanner.js';
import { killPids } from './lib/killer.js';

export const name = 'dsh-orphan-cleaner';
export const inject = ['webServer'];

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
 * 本地工具（curl / 脚本）两者都没有，放行。
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
  async function runKill({ groupIds = [] } = {}) {
    const fresh = await getReport({ force: true });

    const wanted = new Set((Array.isArray(groupIds) ? groupIds : []).map(String));
    const selected = fresh.groups.filter(group => !group.blocked && wanted.has(group.id));

    const targets = new Map();
    for (const group of selected) {
      for (const member of group.members) targets.set(member.pid, group);
    }

    if (targets.size === 0) {
      return {
        ok: true,
        requested: 0,
        killed: [],
        failed: [],
        before: fresh.summary,
        after: fresh.summary,
        message: '没有匹配到可清理的孤儿进程。',
      };
    }

    const result = await killPids([...targets.keys()]);

    // 清理后再扫一次，把真实释放量报给用户。
    const after = await getReport({ force: true });
    const freedBytes = selected.reduce((sum, group) => sum + group.totalWs, 0);
    lastKill = { at: Date.now(), killed: result.killed.length, failed: result.failed.length, freedBytes };

    return {
      ok: result.ok,
      requested: result.requested,
      killed: result.killed,
      failed: result.failed,
      freedBytes,
      before: fresh.summary,
      after: after.summary,
      message:
        result.failed.length === 0
          ? `已终止 ${result.killed.length} 个进程，释放约 ${formatBytes(freedBytes)}。`
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
            sendJson(res, 200, { ok: true, value: await runKill({ groupIds: body.groupIds }) });
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
