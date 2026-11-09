/**
 * 整树终止。
 *
 * 用 taskkill /F /T 而不是 process.kill：
 *   - /T 连带子树，孤儿组通常是 npx → cmd → server 三层，只杀根会留下孙子进程；
 *   - /F 强杀，这些进程本来就没有优雅退出的渠道（父进程都没了，stdin 也断了）。
 *
 * 本机实测过：用 Stop-Process 杀这种进程池时，PowerShell 会报
 * "subprocess-local: Windows Job runner exited"，命令其实生效但结果丢失；
 * taskkill.exe 没有这个问题。
 */

import { execFile } from 'node:child_process';

/** 单次 taskkill 的超时：正常几毫秒，给足 8 秒容错。 */
const KILL_TIMEOUT = 8000;

function taskkill(pid) {
  return new Promise(resolve => {
    execFile(
      'taskkill.exe',
      ['/F', '/T', '/PID', String(pid)],
      { timeout: KILL_TIMEOUT, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ pid, ok: true });
          return;
        }
        const detail = `${stderr || ''}${stdout || ''}`.trim() || error.message;
        // 进程已经不在了 —— 目的达成，不算失败。
        if (/not found|不存在|没有找到/i.test(detail)) {
          resolve({ pid, ok: true, gone: true });
          return;
        }
        resolve({ pid, ok: false, error: detail });
      },
    );
  });
}

/**
 * 按 pid 逐个终止。串行执行，避免几十个 taskkill 同时起进程把系统压住。
 *
 * @param {number[]} pids
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function killPids(pids, onProgress) {
  const list = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 4))];
  const killed = [];
  const failed = [];

  for (let index = 0; index < list.length; index += 1) {
    const pid = list[index];
    const result = await taskkill(pid);
    if (result.ok) killed.push(pid);
    else failed.push({ pid, error: result.error });
    onProgress?.(index + 1, list.length);
  }

  return {
    requested: list.length,
    killed,
    failed,
    ok: failed.length === 0,
  };
}
