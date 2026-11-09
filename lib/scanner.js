/**
 * 孤儿进程扫描器（Windows）。
 *
 * 「孤儿」的定义：沿 ParentProcessId 上溯，链条终止在一个**已经不存在**的进程上。
 * 注意两个天然陷阱，判定时必须排除，否则会误杀整个桌面：
 *
 *   1. 链条终止于 explorer.exe / services.exe / wininit.exe 等「合法根」时不算孤儿。
 *      它们的父进程（smss.exe）按设计会退出，所有 GUI 程序最终都会走到 explorer。
 *   2. 系统进程（System / csrss / winlogon / dwm …）同理。
 *
 * 剩下真正断裂的，才是「父进程已经死了、自己还活着」的遗留进程。
 */

import { execFile } from 'node:child_process';

/** 走到这些进程就算「找到合法根」，链条正常结束。 */
const LEGIT_ROOTS = new Set([
  'explorer.exe',
  'services.exe',
  'wininit.exe',
  'smss.exe',
  'csrss.exe',
  'winlogon.exe',
  'system',
  'system idle process',
  'secure system',
  'registry',
  'memory compression',
]);

/**
 * 即使父链断裂也绝不参与的进程。
 * 这些要么是系统心脏，要么是用户正在用的图形程序，断了也只是启动器退出而已。
 */
const NEVER_TOUCH = new Set([
  'explorer.exe',
  'services.exe',
  'wininit.exe',
  'smss.exe',
  'csrss.exe',
  'winlogon.exe',
  'lsass.exe',
  'dwm.exe',
  'fontdrvhost.exe',
  'svchost.exe',
  'msmpeng.exe',
  'securityhealthservice.exe',
  'deepseek harness.exe',
  'msedge.exe',
  'msedgewebview2.exe',
  'powershell.exe',
  'pwsh.exe',
  'openconnect.exe',
  'conhost.exe', // 单独判定：仅当父链断裂且不属于任何存活控制台时才纳入
]);

/**
 * 高置信特征：命中即认为是「工具链遗留」，默认勾选。
 * 依据是本机实际形态 —— DSH 的 MCP stdio 连接器与前端 dev server 都会留下这种进程。
 */
const RISK_PATTERNS = [
  { kind: 'mcp', re: /mcp-server|server-redis-mcp|npx-cli\.js|ssh-mcp|playwright-mcp|@modelcontextprotocol/i },
  { kind: 'dev', re: /npm run dev|[/\\]c vite\b|vite\.js|dev\.sh|server\.js|esbuild/i },
];

/** Windows PowerShell 5.1 取快照：一次拿到进程树 + 监听端口 + 是否有可见窗口。 */
const SNAPSHOT_SCRIPT = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$withWindow = @{}
try {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MainWindowHandle -ne [IntPtr]::Zero) { $withWindow[[int]$_.Id] = $true }
  }
} catch { }
$procs = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid     = [int]$_.ProcessId
    ppid    = [int]$_.ParentProcessId
    name    = $_.Name
    cmd     = $_.CommandLine
    created = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }
    ws      = [int64]$_.WorkingSetSize
    win     = $withWindow.ContainsKey([int]$_.ProcessId)
  }
})
$ports = @()
try {
  $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
  })
} catch { }
@{ procs = $procs; ports = $ports } | ConvertTo-Json -Compress -Depth 4
`;

/** ConvertTo-Json 把单元素数组降级成对象，这里统一兜回数组。 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

/**
 * 取一次进程快照。
 * @returns {Promise<{procs: Array, ports: Array, tookMs: number}>}
 */
export async function snapshot({ timeout = 20000 } = {}) {
  const startedAt = Date.now();
  const raw = await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SNAPSHOT_SCRIPT],
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`读取进程列表失败：${stderr?.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('进程列表解析失败（PowerShell 返回了非 JSON 内容）');
  }

  const procs = asArray(parsed?.procs).map(item => ({
    pid: Number(item.pid),
    ppid: Number(item.ppid),
    name: String(item.name ?? ''),
    cmd: typeof item.cmd === 'string' ? item.cmd : '',
    created: typeof item.created === 'string' ? item.created : null,
    ws: Number(item.ws) || 0,
    win: Boolean(item.win),
  }));

  const ports = asArray(parsed?.ports).map(item => ({ port: Number(item.port), pid: Number(item.pid) }));

  return { procs, ports, tookMs: Date.now() - startedAt };
}

/** 计算出链条的终止原因：LEGIT（正常）/ MISSING（父进程已死）/ LOOP（异常，按正常处理）。 */
function terminalReasons(procs) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const reasons = new Map();

  for (const p of procs) {
    let cursor = p;
    let reason = 'LOOP';
    const seen = new Set();

    for (let guard = 0; guard < 64; guard += 1) {
      if (LEGIT_ROOTS.has(cursor.name.toLowerCase())) {
        reason = 'LEGIT';
        break;
      }
      if (seen.has(cursor.pid)) {
        reason = 'LOOP';
        break;
      }
      seen.add(cursor.pid);

      if (!cursor.ppid) {
        reason = 'LEGIT';
        break;
      }
      const parent = byPid.get(cursor.ppid);
      if (!parent) {
        reason = 'MISSING';
        break;
      }
      cursor = parent;
    }

    reasons.set(p.pid, reason);
  }

  return { byPid, reasons };
}

/** 从命令行里认出发起它的包名，让分组标题可读一点。 */
function packageOf(cmd) {
  const scoped = cmd.match(/@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/i);
  if (scoped) return scoped[0];
  const plain = cmd.match(/\b([a-z0-9][a-z0-9._-]*-mcp)\b/i);
  if (plain) return plain[1];
  return null;
}

function classify(cmd) {
  for (const { kind, re } of RISK_PATTERNS) {
    if (re.test(cmd)) return kind;
  }
  return null;
}

/** 自身祖先链：这些 pid 永远不能被清理（当前 Host、Electron shell、以及它们的父进程）。 */
function selfChain(byPid, selfPid) {
  const chain = new Set([selfPid]);
  let cursor = byPid.get(selfPid);
  for (let guard = 0; guard < 64 && cursor; guard += 1) {
    chain.add(cursor.pid);
    cursor = cursor.ppid ? byPid.get(cursor.ppid) : null;
  }
  return chain;
}

function formatCommand(cmd, limit = 120) {
  const flat = cmd.replace(/\s+/gu, ' ').trim();
  // 命令行里可能带 redis 口令之类的凭据，展示前抹掉。
  const masked = flat.replace(/(redis|mysql|postgres(?:ql)?|mongodb):\/\/\S+/gi, '$1://***');
  return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
}

/**
 * 分析一次快照，产出可直接给 UI 使用的分组结果。
 *
 * @param {Array} procs snapshot().procs
 * @param {Array} ports snapshot().ports
 * @param {{selfPid?: number, now?: number}} options
 */
export function analyze(procs, ports, { selfPid = process.pid, now = Date.now() } = {}) {
  const { byPid, reasons } = terminalReasons(procs);
  const portMap = new Map(); // pid -> 监听端口列表
  for (const item of ports) {
    if (!Number.isInteger(item.pid)) continue;
    const list = portMap.get(item.pid) ?? [];
    list.push(item.port);
    portMap.set(item.pid, list);
  }

  const self = selfChain(byPid, selfPid);

  // 只关心「父链断裂」的进程；其余（LEGIT）一律不进视野。
  const missing = procs.filter(p => reasons.get(p.pid) === 'MISSING' && !self.has(p.pid) && p.pid > 4);

  // 归组：每个断裂链的最顶端那个进程就是组根。
  const rootOf = new Map();
  for (const p of missing) {
    let cursor = p;
    const seen = new Set();
    while (!seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      const parent = cursor.ppid ? byPid.get(cursor.ppid) : null;
      if (!parent || reasons.get(parent.pid) !== 'MISSING' || self.has(parent.pid)) break;
      cursor = parent;
    }
    rootOf.set(p.pid, cursor.pid);
  }

  const buckets = new Map();
  for (const p of missing) {
    const root = rootOf.get(p.pid) ?? p.pid;
    const list = buckets.get(root) ?? [];
    list.push(p);
    buckets.set(root, list);
  }

  const groups = [];
  for (const [rootPid, members] of buckets) {
    const root = byPid.get(rootPid) ?? members[0];
    const kind = members.map(m => classify(m.cmd)).find(Boolean) ?? null;
    const pkg = packageOf(root.cmd) ?? members.map(m => packageOf(m.cmd)).find(Boolean) ?? null;
    const createdMs = root.created ? Date.parse(root.created) : now;
    const totalWs = members.reduce((sum, m) => sum + (m.ws || 0), 0);
    const listening = [...new Set(members.flatMap(m => portMap.get(m.pid) ?? []))].sort((a, b) => a - b);
    const touchesProtected = members.some(m => NEVER_TOUCH.has(m.name.toLowerCase()) && m.name.toLowerCase() !== 'conhost.exe');
    // 有可见窗口 = 用户正在用的图形程序。它们的父进程退出纯属启动器正常收工，不是遗留。
    const interactive = members.some(m => m.win);

    groups.push({
      id: `g${rootPid}`,
      rootPid,
      rootName: root.name,
      createdAt: root.created,
      createdMs,
      ageMs: Math.max(0, now - (Number.isFinite(createdMs) ? createdMs : now)),
      kind: kind ?? 'other',
      label: pkg || formatCommand(root.cmd, 60) || root.name,
      high: Boolean(kind) && !touchesProtected,
      blocked: touchesProtected,
      interactive,
      ports: listening,
      processCount: members.length,
      totalWs,
      members: members
        .slice()
        .sort((a, b) => a.pid - b.pid)
        .map(m => ({
          pid: m.pid,
          name: m.name,
          ws: m.ws,
          cmd: formatCommand(m.cmd, 200),
        })),
    });
  }

  // 孤立的 conhost 没有命令行特征，按「创建时间贴近某个高置信组」并进去，避免界面上刷出十几个 7MB 的空组。
  const conhostOnly = groups.filter(g => g.members.every(m => m.name.toLowerCase() === 'conhost.exe'));
  const highGroups = groups.filter(g => g.high);
  for (const group of conhostOnly) {
    let best = null;
    for (const candidate of highGroups) {
      const delta = Math.abs(candidate.createdMs - group.createdMs);
      if (delta <= 5000 && (!best || delta < Math.abs(best.createdMs - group.createdMs))) best = candidate;
    }
    if (!best) continue;
    best.members.push(...group.members);
    best.processCount += group.processCount;
    best.totalWs += group.totalWs;
    best.absorbedConhost = (best.absorbedConhost ?? 0) + group.processCount;
    group.absorbedBy = best.id;
  }

  const visible = groups.filter(g => !g.absorbedBy);
  visible.sort((a, b) => {
    if (a.high !== b.high) return a.high ? -1 : 1;
    if (a.interactive !== b.interactive) return a.interactive ? 1 : -1;
    return b.createdMs - a.createdMs;
  });

  const highList = visible.filter(g => g.high);
  const others = visible.filter(g => !g.high);
  return {
    generatedAt: now,
    selfPid,
    totalProcesses: procs.length,
    groups: visible,
    summary: {
      groupCount: visible.length,
      highGroupCount: highList.length,
      highProcessCount: highList.reduce((n, g) => n + g.processCount, 0),
      highBytes: highList.reduce((n, g) => n + g.totalWs, 0),
      // 非高置信的断裂进程：多数是「启动器退出、程序还在跑」，界面默认折叠。
      otherGroupCount: others.length,
      otherBytes: others.reduce((n, g) => n + g.totalWs, 0),
      interactiveGroupCount: others.filter(g => g.interactive).length,
    },
  };
}

/** 扫描 + 分析一条龙。 */
export async function scan(options = {}) {
  const { procs, ports, tookMs } = await snapshot(options);
  const report = analyze(procs, ports, options);
  return { ...report, scanMs: tookMs };
}
