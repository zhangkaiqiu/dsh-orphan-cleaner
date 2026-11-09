# dsh-orphan-cleaner

扫描并清理**孤儿进程** —— 父进程已经退出、自己还挂着的遗留进程。

对 DSH 来说这是高频问题：MCP stdio 连接器每建立一次连接就新起一套
`npx → cmd → mcp-server` 进程组，Host 退出时不保证回收它们。反复重启后，
几十个 40MB 的 node 进程会一起抢 CPU 和数据库连接。

## 它怎么判定孤儿

沿 `ParentProcessId` 往上追，链条终止在一个**已经不存在的进程**上，就是孤儿。

两个必须排除的天然陷阱（做错了会误杀整个桌面）：

1. **链条终止于 `explorer.exe` / `services.exe` / `wininit.exe` 不算孤儿**。
   它们的父进程 `smss.exe` 按设计会退出，所有 GUI 程序最终都会走到 explorer。
2. 系统进程（System、csrss、winlogon、dwm…）同理。

剩下真正断裂的进程，再按命令行特征分成两档：

| 档位 | 判据 | 默认 |
|---|---|---|
| 高置信 | 命令行命中 `mcp-server` / `server-redis-mcp` / `npx-cli.js` / `ssh-mcp` / `playwright-mcp` / `npm run dev` / `vite` / `dev.sh` / `server.js` / `esbuild` | ✅ 勾选 |
| 待确认 | 其它断裂进程（VPN 终端、浏览器后台等） | 不勾 |

**受保护**：系统进程、桌面壳、当前 Host 及其全部祖先链、以及 `msedge` / `openconnect` /
`powershell` 这类进程，既不会被勾选，也不提供一键清理。

## 界面

按钮在会话头部工具栏，紧挨着「快捷启动」的右边（order 31）。角标显示高置信组的数量，
启动 DSH 后会自动扫一次，有残留时角标直接变成红色。

面板里按「进程组」聚合：一组就是一次启动留下的完整进程树，显示内存、创建时间、
占用端口和成员 pid。勾选后点「结束选中」，会做二次确认并重新扫描校验。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `orphan_scan` | 返回分组摘要（高置信 / 待确认、内存、端口） |
| `orphan_kill` | 清理。默认 `onlyHigh=true`；也可传 `groupIds` / `pids` 精确指定 |

清理前会重新扫一次，只对「刚刚确认仍是孤儿」的 pid 动手 —— PID 复用导致的错杀会被这一层挡住。

## 安装

从 GitHub 直接装：

```bash
dsh plugin --profile desktop add github:zhangkaiqiu/dsh-orphan-cleaner
```

`desktop` 是桌面版的 profile 名（命令行版用 `web`，改成你自己的 profile）。也可以锁 tag：

```bash
dsh plugin --profile desktop add github:zhangkaiqiu/dsh-orphan-cleaner#v0.1.0
```

更新用 `dsh plugin --profile desktop update dsh-orphan-cleaner`（跟 main 时有效；装了 tag 的
升级要重新 `add` 新 tag），装完重启 DSH。

本地开发时用 **tarball** 安装，不能用 `link:` 或目录依赖（目录依赖会让 Node 把入口 realpath
回源码盘，peerDependencies 解析出第二份实例）：

```bash
npm pack                                  # 生成 dsh-orphan-cleaner-0.1.0.tgz
```

然后在 DSH 插件管理页安装这个 tgz。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/orphan-cleaner/scan?force=1` | 扫描，`force=1` 绕过 2 秒缓存 |
| POST | `/orphan-cleaner/kill` | body：`{ groupIds?, pids?, onlyHigh? }` |
| GET | `/orphan-cleaner/state` | 启动自动扫描摘要 + 上次清理结果 |

所有写接口都有跨站检查（`Origin` / `Sec-Fetch-Site`），防恶意网页远程杀进程。
