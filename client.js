window.__ModuleLoader__.load({
  id: 'dsh-orphan-cleaner',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    const STYLE_ID = 'dsh-orphan-cleaner-style';
    const API = '/orphan-cleaner';

    const ZH = {
      trigger: '孤儿进程',
      title: '孤儿进程清理',
      subtitle: '父进程已退出、自己还残留的进程',
      scanning: '扫描中…',
      rescan: '重新扫描',
      empty: '很干净，没有发现孤儿进程。',
      emptyFiltered: '没有发现高置信的遗留进程。另有 {n} 组父链也断裂了，但多半是正在运行的程序，勾选上方「显示全部」可查看。',
      showAll: '显示全部断裂进程',
      error: '扫描失败',
      killSelected: '结束选中',
      killing: '正在结束…',
      selected: '已选',
      processUnit: '个进程',
      high: '高置信',
      other: '待确认',
      blocked: '受保护',
      running: '运行中',
      groupCount: '组',
      noSelection: '先勾选要清理的组',
      confirmTitle: '确认结束这些进程？',
      confirmBody: '整棵进程树会被强制终止，不做优雅退出。',
      confirmYes: '结束',
      confirmNo: '取消',
      totalLabel: '高置信',
      otherLabel: '待确认',
      ports: '端口',
      created: '创建于',
      ago: '已',
      min: '分钟',
      hour: '小时',
      day: '天',
      released: '已释放',
      failedCount: '个失败',
      moreMembers: '等',
      protectedHint: '受保护进程不提供一键清理',
      maskHint: '命令行中的口令已抹除',
      close: '关闭',
    };

    const EN = {
      trigger: 'Orphans',
      title: 'Orphan process cleaner',
      subtitle: 'Processes whose parent already exited',
      scanning: 'Scanning…',
      rescan: 'Rescan',
      empty: 'Clean — no orphan processes found.',
      emptyFiltered: 'No high-confidence leftovers. {n} more groups also have a broken parent chain, but are most likely running apps — enable the toggle above to see them.',
      showAll: 'Show all broken chains',
      error: 'Scan failed',
      killSelected: 'End selected',
      killing: 'Ending…',
      selected: 'selected',
      processUnit: 'processes',
      high: 'High confidence',
      other: 'Needs review',
      blocked: 'Protected',
      running: 'running',
      groupCount: 'groups',
      noSelection: 'Select at least one group',
      confirmTitle: 'End these processes?',
      confirmBody: 'The whole process tree will be force-killed.',
      confirmYes: 'End',
      confirmNo: 'Cancel',
      totalLabel: 'High confidence',
      otherLabel: 'Needs review',
      ports: 'Ports',
      created: 'Created',
      ago: 'for',
      min: 'min',
      hour: 'h',
      day: 'd',
      released: 'released',
      failedCount: 'failed',
      moreMembers: 'and',
      protectedHint: 'Protected processes cannot be bulk-killed',
      maskHint: 'Secrets in command lines are masked',
      close: 'Close',
    };

    const CSS = `
.oc-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;font-family:inherit;transition:background .12s,color .12s;}
.oc-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.oc-trigger[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);}
.oc-trigger-icon{font-size:13px;line-height:1;}
.oc-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#e5484d;color:#fff;font-size:10px;line-height:16px;text-align:center;font-weight:600;}
.oc-badge[data-idle="true"]{background:var(--dsw-alias-bg-layer-3,#5553);color:var(--dsw-alias-label-secondary);font-weight:400;}
.oc-panel{position:fixed;z-index:60;display:flex;flex-direction:column;max-height:min(68vh,640px);border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 12px 40px #0003;overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary);}
.oc-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.oc-title{font-weight:600;font-size:13px;}
.oc-sub{color:var(--dsw-alias-label-secondary);font-size:11px;}
.oc-head-actions{margin-left:auto;display:flex;align-items:center;gap:6px;}
.oc-mini{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font-size:11px;cursor:pointer;font-family:inherit;}
.oc-mini:hover{background:var(--dsw-alias-bg-layer-2);}
.oc-mini:disabled{opacity:.5;cursor:default;}
.oc-summary{display:flex;gap:14px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;flex-wrap:wrap;}
.oc-summary b{color:var(--dsw-alias-label-primary);font-weight:600;}
.oc-toggle{display:inline-flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;user-select:none;}
.oc-toggle input{margin:0;accent-color:#4c8dff;}
.oc-list{overflow:auto;padding:6px 8px;display:flex;flex-direction:column;gap:6px;min-height:60px;}
.oc-group{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 9px;background:var(--dsw-alias-bg-layer-1,#0000);}
.oc-group[data-checked="true"]{border-color:#4c8dff88;background:#4c8dff10;}
.oc-group[data-blocked="true"]{opacity:.65;}
.oc-row1{display:flex;align-items:center;gap:7px;}
.oc-check{width:14px;height:14px;margin:0;accent-color:#4c8dff;cursor:pointer;flex:none;}
.oc-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.oc-tag{flex:none;font-size:10px;padding:1px 5px;border-radius:4px;background:#4c8dff22;color:#4c8dff;}
.oc-tag[data-kind="other"]{background:#f5a62322;color:#c27c0e;}
.oc-tag[data-kind="blocked"]{background:#8882;color:var(--dsw-alias-label-secondary);}
.oc-row2{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:3px;padding-left:21px;}
.oc-row3{margin-top:4px;padding-left:21px;display:flex;flex-wrap:wrap;gap:4px;}
.oc-proc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,#8881);color:var(--dsw-alias-label-secondary);}
.oc-port{font-size:10px;padding:1px 5px;border-radius:4px;background:#4c8dff18;color:#4c8dff;}
.oc-cmd{margin-top:4px;padding-left:21px;color:var(--dsw-alias-label-secondary);font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.oc-foot{display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);}
.oc-foot-hint{color:var(--dsw-alias-label-secondary);font-size:11px;}
.oc-primary{margin-left:auto;height:28px;padding:0 14px;border-radius:7px;border:1px solid transparent;background:#e5484d;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;}
.oc-primary:hover{background:#cf3d42;}
.oc-primary:disabled{opacity:.45;cursor:default;}
.oc-banner{margin:8px 12px 0;padding:7px 9px;border-radius:7px;font-size:11px;background:#4c8dff16;color:var(--dsw-alias-label-secondary);}
.oc-banner[data-tone="bad"]{background:#e5484d16;color:#c3353a;}
.oc-banner[data-tone="good"]{background:#2ea04316;color:#1f7a33;}
.oc-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;}
.oc-loading{padding:22px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;}
`;

    function installStyles() {
      const existing = document.getElementById(STYLE_ID);
      if (existing) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => {
        element.remove();
      };
    }

    function formatBytes(bytes) {
      const mb = (Number(bytes) || 0) / (1024 * 1024);
      if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
      return `${Math.max(1, Math.round(mb))} MB`;
    }

    function formatAge(ms, t) {
      const total = Number(ms) || 0;
      const minutes = Math.floor(total / 60000);
      if (minutes < 60) return `${Math.max(1, minutes)}${t('min')}`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}${t('hour')}`;
      return `${Math.floor(hours / 24)}${t('day')}`;
    }

    function formatClock(iso) {
      if (!iso) return '—';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '—';
      const pad = value => String(value).padStart(2, '0');
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      return date.toDateString() === new Date().toDateString() ? clock : `${date.getMonth() + 1}-${pad(date.getDate())} ${clock}`;
    }

    function OrphanEntry(props) {
      const t = props.t ?? (key => ZH[key] ?? key);

      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState({ top: 64, right: 24 });
      const [report, setReport] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [checked, setChecked] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      const [confirming, setConfirming] = useState(false);
      const [banner, setBanner] = useState(null);
      const [badge, setBadge] = useState(null);
      const [showAll, setShowAll] = useState(false);

      const buttonRef = useRef(null);
      const panelRef = useRef(null);

      const request = useCallback(async (path, body) => {
        const response = await fetch(`${API}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = await response.json().catch(() => null);
        if (!payload) throw new Error('宿主没有返回有效数据');
        if (!payload.ok) throw new Error(payload.error || '请求失败');
        return payload.value;
      }, []);

      const applyReport = useCallback(value => {
        setReport(value);
        const next = new Set();
        for (const group of value.groups ?? []) {
          if (group.high && !group.blocked) next.add(group.id);
        }
        setChecked(next);
      }, []);

      const scan = useCallback(
        async (force = false) => {
          setLoading(true);
          setError('');
          try {
            applyReport(await request(`/scan${force ? '?force=1' : ''}`));
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setLoading(false);
          }
        },
        [applyReport, request],
      );

      // 启动时的那次自动扫描结果只用来做角标，不打扰用户。
      useEffect(() => {
        let alive = true;
        void (async () => {
          try {
            const value = await request('/state');
            if (alive && value?.auto?.summary) setBadge(value.auto.summary);
          } catch {
            // 角标属于锦上添花，失败就算了。
          }
        })();
        return () => {
          alive = false;
        };
      }, [request]);

      const toggle = useCallback(() => {
        if (open) {
          setOpen(false);
          return;
        }
        const rect = buttonRef.current?.getBoundingClientRect();
        if (rect) {
          setAnchor({
            top: Math.round(rect.bottom + 8),
            right: Math.max(12, Math.round(window.innerWidth - rect.right)),
          });
        }
        setOpen(true);
        setBanner(null);
        setConfirming(false);
        void scan(false);
      }, [open, scan]);

      // 点击面板外面收起
      useEffect(() => {
        if (!open) return undefined;
        const onMouseDown = event => {
          const target = event.target;
          if (panelRef.current?.contains(target)) return;
          if (buttonRef.current?.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = event => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onMouseDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const toggleGroup = useCallback(id => {
        setChecked(previous => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setConfirming(false);
      }, []);

      const doKill = useCallback(async () => {
        const ids = [...checked];
        if (ids.length === 0) return;
        setBusy(true);
        setConfirming(false);
        setBanner(null);
        try {
          const value = await request('/kill', { groupIds: ids });
          const failed = value.failed?.length ?? 0;
          setBanner({
            tone: failed === 0 ? 'good' : 'bad',
            text:
              failed === 0
                ? `${value.message}`
                : `${value.message} ${failed}${t('failedCount')}。`,
          });
          setChecked(new Set());
          await scan(true);
          setBadge(value.after ? { highGroupCount: value.after.highGroupCount, highProcessCount: value.after.highProcessCount, highBytes: value.after.highBytes } : null);
        } catch (caught) {
          setBanner({ tone: 'bad', text: caught instanceof Error ? caught.message : String(caught) });
        } finally {
          setBusy(false);
        }
      }, [checked, request, scan, t]);

      const summary = report?.summary ?? null;
      const highCount = summary?.highGroupCount ?? 0;
      const badgeCount = summary ? highCount : (badge?.highGroupCount ?? 0);
      const selectedCount = checked.size;

      const trigger = h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'oc-trigger',
          'data-active': open ? 'true' : 'false',
          title: t('title'),
          onClick: toggle,
        },
        h('span', { className: 'oc-trigger-icon', 'aria-hidden': 'true' }, '🧹'),
        h('span', null, t('trigger')),
        h(
          'span',
          { className: 'oc-badge', 'data-idle': badgeCount === 0 ? 'true' : 'false' },
          String(badgeCount),
        ),
      );

      if (!open) return trigger;

      const head = h(
        'div',
        { className: 'oc-head' },
        h('span', { className: 'oc-title' }, t('title')),
        h('span', { className: 'oc-sub' }, t('subtitle')),
        h(
          'div',
          { className: 'oc-head-actions' },
          h(
            'button',
            { type: 'button', className: 'oc-mini', disabled: loading || busy, onClick: () => void scan(true) },
            loading ? t('scanning') : t('rescan'),
          ),
        ),
      );

      const allGroups = report?.groups ?? [];
      // 默认只展示高置信组。其余断裂进程多半是「启动器收工、程序还在跑」，折叠掉免得吓人。
      const visibleGroups = allGroups.filter(group => showAll || group.high);
      const hiddenCount = allGroups.length - visibleGroups.length;

      const summaryBar = summary
        ? h(
            'div',
            { className: 'oc-summary' },
            h('span', null, `${t('totalLabel')} `, h('b', null, String(summary.highGroupCount)), ` ${t('groupCount')}`),
            h('span', null, h('b', null, String(summary.highProcessCount)), ` ${t('processUnit')}`),
            h('span', null, h('b', null, formatBytes(summary.highBytes))),
            h('span', null, `${t('otherLabel')} `, h('b', null, String(summary.otherGroupCount))),
            hiddenCount > 0 || showAll
              ? h(
                  'label',
                  { className: 'oc-toggle' },
                  h('input', {
                    type: 'checkbox',
                    checked: showAll,
                    onChange: event => setShowAll(event.target.checked),
                  }),
                  `${t('showAll')}${hiddenCount > 0 ? ` (${hiddenCount})` : ''}`,
                )
              : null,
          )
        : null;

      let body;
      if (loading && !report) {
        body = h('div', { className: 'oc-loading' }, t('scanning'));
      } else if (error) {
        body = h('div', { className: 'oc-banner', 'data-tone': 'bad' }, `${t('error')}：${error}`);
      } else if (!report || visibleGroups.length === 0) {
        body = h(
          'div',
          { className: 'oc-empty' },
          hiddenCount > 0
            ? t('emptyFiltered').replace('{n}', String(hiddenCount))
            : t('empty'),
        );
      } else {
        body = h(
          'div',
          { className: 'oc-list' },
          visibleGroups.map(group => {
            const isChecked = checked.has(group.id);
            const shown = group.members.slice(0, 6);
            const rest = group.members.length - shown.length;
            return h(
              'div',
              {
                key: group.id,
                className: 'oc-group',
                'data-checked': isChecked ? 'true' : 'false',
                'data-blocked': group.blocked ? 'true' : 'false',
              },
              h(
                'div',
                { className: 'oc-row1' },
                h('input', {
                  type: 'checkbox',
                  className: 'oc-check',
                  checked: isChecked,
                  disabled: group.blocked || busy,
                  onChange: () => toggleGroup(group.id),
                }),
                h(
                  'span',
                  { className: 'oc-tag', 'data-kind': group.blocked ? 'blocked' : group.high ? 'high' : 'other' },
                  group.blocked ? t('blocked') : group.high ? t('high') : t('other'),
                ),
                h('span', { className: 'oc-name', title: group.label }, group.label),
                group.interactive && !group.high
                  ? h('span', { className: 'oc-tag', 'data-kind': 'blocked' }, t('running'))
                  : null,
              ),
              h(
                'div',
                { className: 'oc-row2' },
                `${group.processCount} ${t('processUnit')} · ${formatBytes(group.totalWs)} · ${t('created')} ${formatClock(group.createdAt)} (${t('ago')} ${formatAge(group.ageMs, t)})`,
              ),
              group.ports.length > 0
                ? h(
                    'div',
                    { className: 'oc-row3' },
                    group.ports.map(port => h('span', { key: `p${port}`, className: 'oc-port' }, `:${port}`)),
                  )
                : null,
              h(
                'div',
                { className: 'oc-row3' },
                shown.map(member =>
                  h('span', { key: member.pid, className: 'oc-proc' }, `${member.name}(${member.pid})`),
                ),
                rest > 0 ? h('span', { className: 'oc-proc' }, `${t('moreMembers')} ${rest}`) : null,
              ),
              h('div', { className: 'oc-cmd', title: group.members[0]?.cmd ?? '' }, group.members[0]?.cmd ?? ''),
            );
          }),
        );
      }

      const foot = h(
        'div',
        { className: 'oc-foot' },
        h('span', { className: 'oc-foot-hint' }, `${t('selected')} ${selectedCount}`),
        h(
          'button',
          {
            type: 'button',
            className: 'oc-primary',
            disabled: busy || selectedCount === 0,
            onClick: () => (confirming ? void doKill() : setConfirming(true)),
          },
          busy ? t('killing') : confirming ? t('confirmYes') : t('killSelected'),
        ),
      );

      const bannerNode = banner
        ? h('div', { className: 'oc-banner', 'data-tone': banner.tone }, banner.text)
        : confirming
          ? h(
              'div',
              { className: 'oc-banner', 'data-tone': 'bad' },
              `${t('confirmTitle')} ${t('confirmBody')}`,
            )
          : null;

      const panel = h(
        'div',
        {
          ref: panelRef,
          className: 'oc-panel',
          style: { top: `${anchor.top}px`, right: `${anchor.right}px`, width: '560px' },
          role: 'dialog',
          'aria-label': t('title'),
        },
        head,
        summaryBar,
        bannerNode,
        body,
        foot,
      );

      return h(React.Fragment, null, trigger, panel);
    }

    return {
      // 只声明真正需要的服务。locale 取不到就退回内置中文，不让插件因此起不来。
      inject: ['slots'],
      apply(ctx) {
        // 激活路径全部兜底：任何一步失败都只记录、不外抛。
        // cordis 会把 apply 的异常吞成 fiber 的 failed 状态，web boot 见到 failed 会整体报错。
        try {
          ctx.effect(installStyles, 'dsh-orphan-cleaner: styles');
        } catch (error) {
          console.error('[dsh-orphan-cleaner] styles failed:', error);
        }

        let locale = null;
        try {
          locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) ?? ctx.locale ?? null;
        } catch (error) {
          console.error('[dsh-orphan-cleaner] locale unavailable:', error);
          locale = null;
        }

        let translate = null;
        if (locale && typeof locale.bind === 'function') {
          try {
            translate = locale.bind('orphan-cleaner');
          } catch (error) {
            console.error('[dsh-orphan-cleaner] locale.bind failed:', error);
          }
        }

        if (locale && typeof locale.register === 'function') {
          try {
            ctx.effect(() => {
              // 命名空间已存在时 register 会抛错，那是 HMR / web boot 重试的幂等噪音，吞掉。
              const handle = locale.register('orphan-cleaner', { zh: ZH, en: EN });
              return typeof handle === 'function' ? handle : () => {};
            }, 'dsh-orphan-cleaner: locale');
          } catch (error) {
            console.error('[dsh-orphan-cleaner] locale.register failed:', error);
          }
        }

        try {
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'orphan-cleaner',
                // 紧挨着「快捷启动」（order 30）排在它右边。
                order: 31,
                label: () => (translate ? translate('trigger') : ZH.trigger),
                inject: () => ({
                  t: key => {
                    try {
                      const value = translate?.(key);
                      return typeof value === 'string' && value && value !== key ? value : (ZH[key] ?? key);
                    } catch {
                      return ZH[key] ?? key;
                    }
                  },
                }),
              },
              OrphanEntry,
            ),
          );
        } catch (error) {
          console.error('[dsh-orphan-cleaner] slots failed:', error);
        }
      },
    };
  },
});
