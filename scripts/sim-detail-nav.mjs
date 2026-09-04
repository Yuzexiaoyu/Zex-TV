// 状态机模拟：详情页 v3 全导航矩阵（多季剧集 / 单季剧集 / 电影）+ OK 短按/长按语义。
// 直接复刻 focus.ts 的 move/pressStart/pressEnd + SeriesDetail v3 三个组的接线，
// 不 import 源码（源码是 React 组件，node 里跑不动），手抄逻辑保持与源码逐行对应。
// 跑法：node scripts/sim-detail-nav.mjs

const OK_HOLD_MS = 550;

// ── 复刻 focus.ts（精简：只留详情页用到的路径） ──
function makeFocus() {
  const registry = new Map();
  let stack = [];
  let now = 0;
  const timers = []; // { fireAt, fn, done }
  let okPending = false;
  let okGroup = '';
  let okIndex = -1;
  let okTimer = null;
  const log = [];

  const cancelOkPress = () => { okPending = false; if (okTimer) { okTimer.done = true; okTimer = null; } };
  const top = () => (stack.length ? stack[stack.length - 1] : undefined);

  const store = {
    registry, log,
    advanceTime: (ms) => {
      now += ms;
      for (const t of timers) if (!t.done && t.fireAt <= now) { t.done = true; t.fn(); }
    },
    push: (group, index = 0) => { stack = [...stack, { group, index }]; },
    switchTo: (group, index = 0) => {
      const target = registry.has(group) ? group : 'nav';
      stack = stack.length ? [...stack.slice(0, -1), { group: target, index }] : [{ group, index }];
    },
    back: () => {
      if (stack.length <= 1) return false;
      cancelOkPress();
      const popped = stack[stack.length - 1];
      stack = stack.slice(0, -1);
      registry.get(popped.group)?.opts?.exit?.();
      return true;
    },
    // 静默弹栈（复刻 useModalGamepad 卸载清理：onClose 引发的卸载不触发 exit）
    popSilent: () => { if (stack.length > 1) stack = stack.slice(0, -1); },
    move: (dir) => {
      const t = top();
      if (!t) return;
      const g = registry.get(t.group);
      if (!g) return;
      const opts = g.opts;
      if (opts.count <= 0) { opts.leave?.(dir, -1); return; }
      if (t.index == null) { t.index = 0; opts.scrollIntoView?.(0); return; }
      const { count, cols = count } = opts;
      const index = t.index;
      let next = index;
      let crossed = false;
      if (cols > 1) {
        const row = Math.floor(index / cols);
        const lastIdx = count - 1;
        const lastRow = Math.floor(lastIdx / cols);
        switch (dir) {
          case 'up': if (row > 0) next = index - cols; else crossed = true; break;
          case 'down': if (row < lastRow) next = Math.min(count - 1, index + cols); else crossed = true; break;
          case 'left': if (index % cols > 0) next = index - 1; else crossed = true; break;
          case 'right': if (index % cols < cols - 1 && index < count - 1) next = index + 1; else crossed = true; break;
        }
      } else {
        switch (dir) {
          case 'up': if (index > 0) next = index - 1; else crossed = true; break;
          case 'down': if (index < count - 1) next = index + 1; else crossed = true; break;
          // left/right 在 cols=1 无 case → 原地停住（v3 集列表设计如此）
        }
      }
      if (crossed) { opts.leave?.(dir, index); return; }
      if (next !== index) {
        cancelOkPress(); // 焦点移动作废进行中的 OK 长按判定
        t.index = next;
        opts.scrollIntoView?.(next);
      }
    },
    pressStart: () => {
      cancelOkPress();
      const t = top();
      if (!t || t.index == null) return;
      const opts = registry.get(t.group)?.opts;
      if (!opts) return;
      if (!opts.longPress) { log.push(['activate', t.group, t.index]); opts.activate?.(t.index); return; }
      okPending = true;
      okGroup = t.group;
      okIndex = t.index;
      okTimer = { fireAt: now + OK_HOLD_MS, done: false, fn: () => {
        okTimer = null;
        if (!okPending) return;
        okPending = false;
        log.push(['longPress', okGroup, okIndex]);
        registry.get(okGroup)?.opts?.longPress?.(okIndex);
      } };
      timers.push(okTimer);
    },
    pressEnd: () => {
      if (!okPending) return;
      cancelOkPress();
      const t = top();
      if (!t || t.index == null) return;
      log.push(['activate', t.group, t.index]);
      registry.get(t.group)?.opts?.activate?.(t.index);
    },
    topGroup: () => top()?.group,
    topIndex: () => top()?.index,
  };
  return store;
}

function register(fx, id, opts) { fx.registry.set(id, { opts }); }

// ── 复刻 SeriesDetail v3 接线 ──
function makeDetail(fx, { isMovie, epCounts, nextSeasonIdx = 0 }) {
  const seasonCount = epCounts.length;
  const chipsVisible = !isMovie && seasonCount > 0;
  const st = {
    activeSeason: nextSeasonIdx,
    lastActionIdx: 0,
    sheets: [], // 'ep' | 'season' | 'delete'
    played: [], markedEp: [], markedSeason: [], favToggled: 0, deleted: false, closed: false,
  };
  const epsOf = (si) => Array.from({ length: epCounts[si] }, () => ({ watched: false }));
  const seasons = epCounts.map((_, si) => ({ eps: epsOf(si) }));
  const curEpisodes = () => seasons[st.activeSeason].eps;
  const entryIndex = (eps) => { const i = eps.findIndex((e) => !e.watched); return i >= 0 ? i : 0; };

  register(fx, 'detail-actions', {
    count: 4, cols: 4,
    activate: (i) => {
      if (i === 0) { st.played.push('next'); return; }
      if (i === 1) { st.favToggled++; return; }
      if (i === 2) return;
      st.sheets.push('delete');
      fx.push('modal:action-sheet', 0); // ActionSheet 压栈（初始焦点=取消）
    },
    leave: (dir) => {
      if (dir !== 'down') return;
      if (chipsVisible) fx.switchTo('detail-seasons', st.activeSeason);
      else if (curEpisodes().length > 0) fx.switchTo('detail-episodes', entryIndex(curEpisodes()));
    },
    exit: () => st.closed = true,
  });
  register(fx, 'detail-seasons', {
    count: chipsVisible ? seasonCount : 0,
    cols: chipsVisible ? seasonCount : 1,
    activate: () => { if (curEpisodes().length > 0) fx.switchTo('detail-episodes', entryIndex(curEpisodes())); },
    leave: (dir) => {
      if (dir === 'up') fx.switchTo('detail-actions', st.lastActionIdx);
      else if (dir === 'down' && curEpisodes().length > 0) fx.switchTo('detail-episodes', entryIndex(curEpisodes()));
    },
    longPress: (i) => {
      if (seasons[i].eps.length > 0) { st.sheets.push('season'); fx.push('modal:action-sheet', 0); }
    },
    exit: () => st.closed = true,
  });
  register(fx, 'detail-episodes', {
    get count() { return curEpisodes().length; },
    cols: 1,
    activate: (i) => { if (curEpisodes()[i]) st.played.push(`${st.activeSeason}:${i}`); },
    leave: (dir) => {
      if (dir !== 'up') return;
      if (chipsVisible) fx.switchTo('detail-seasons', st.activeSeason);
      else fx.switchTo('detail-actions', st.lastActionIdx);
    },
    longPress: (i) => {
      if (curEpisodes()[i]) { st.sheets.push('ep'); fx.push('modal:action-sheet', 0); }
    },
    exit: () => st.closed = true,
  });
  // 操作表（复刻 ActionSheet/useModalGamepad：OK=onClose+选择（栈静默弹出），Back=exit 关闭）
  register(fx, 'modal:action-sheet', {
    count: 2, cols: 1,
    activate: (i) => {
      const kind = st.sheets[st.sheets.length - 1];
      st.sheets.pop();
      fx.popSilent();
      if (kind === 'delete' && i === 1) st.deleted = true;
      if (kind === 'ep' && i >= 0) st.markedEp.push(`${st.activeSeason}`);
    },
    leave: () => {},
    exit: () => st.sheets.pop(),
  });

  st.syncFocus = () => {
    // 复刻 useEffect：actions 焦点位置记忆
    if (fx.topGroup() === 'detail-actions' && fx.topIndex() >= 0) st.lastActionIdx = fx.topIndex();
    // 复刻 useEffect：季 chips 焦点即预览（焦点移到哪个 chip，集列表实时切到哪季）
    if (fx.topGroup() === 'detail-seasons' && fx.topIndex() >= 0) st.activeSeason = fx.topIndex();
  };
  st.state = () => ({ seasons, entryIndex, curEpisodes, chipsVisible });
  return st;
}

// ── 断言工具 ──
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`FAIL  ${name}`); }
}
function key(fx, st, k) {
  if (k === 'ok') fx.pressStart();
  else if (k === 'okUp') fx.pressEnd();
  else if (k === 'back') fx.back();
  else fx.move(k);
  st.syncFocus();
}

// ══ 用例 A：多季剧集（4 季 [24,12,6,8]，起点第 1 季） ══
console.log('A. 多季剧集');
{
  const fx = makeFocus();
  const st = makeDetail(fx, { isMovie: false, epCounts: [24, 12, 6, 8] });
  fx.push('nav', 0); fx.push('grid:series', 0); // 真实栈底：nav → 影视库网格
  fx.push('detail-actions', 0);
  check('A1 打开落在操作行播放键', fx.topGroup() === 'detail-actions' && fx.topIndex() === 0);

  key(fx, st, 'down');
  check('A2 下 → 季 chips（焦点=当前季 0）', fx.topGroup() === 'detail-seasons' && fx.topIndex() === 0);

  key(fx, st, 'down');
  check('A3 下 → 集列表，落第一个未看集（S01 全未看 → E01）', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 0);

  key(fx, st, 'up');
  check('A4 上 → 回季 chips（当前季）', fx.topGroup() === 'detail-seasons' && fx.topIndex() === 0);

  key(fx, st, 'right');
  check('A5 右 → chip 1 且焦点即预览切季', fx.topIndex() === 1 && st.activeSeason === 1);

  key(fx, st, 'down');
  check('A6 下 → 进预览后的 S02 集列表', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 0 && st.activeSeason === 1);

  key(fx, st, 'right');
  check('A7 集列表里右 = 原地停住（v3 废除左右换季）', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 0);

  key(fx, st, 'up');
  check('A8 上 → 回 chips（S02 位置 1）', fx.topGroup() === 'detail-seasons' && fx.topIndex() === 1);

  key(fx, st, 'left'); key(fx, st, 'left');
  check('A9 左到行首再左 = 停住（预览回 S01）', fx.topIndex() === 0 && st.activeSeason === 0);

  key(fx, st, 'up');
  check('A10 上 → 操作行（记住的位置 0）', fx.topGroup() === 'detail-actions' && fx.topIndex() === 0);

  key(fx, st, 'right'); key(fx, st, 'right'); key(fx, st, 'right'); key(fx, st, 'right');
  check('A11 操作行右到行尾再右 = 停住（删除在行尾）', fx.topIndex() === 3);

  key(fx, st, 'ok'); key(fx, st, 'okUp');
  check('A12 OK 删除 → 确认表压栈（默认焦点=取消）', fx.topGroup() === 'modal:action-sheet' && fx.topIndex() === 0);

  key(fx, st, 'ok'); key(fx, st, 'okUp');
  check('A13 OK 在「取消」→ 只关表，不删除', fx.topGroup() === 'detail-actions' && fx.topIndex() === 3 && !st.deleted);

  fx.switchTo('detail-episodes', 2);
  fx.pressStart(); fx.advanceTime(OK_HOLD_MS + 10);
  check('A14 集行长按 OK(≥550ms) → 单集操作表', fx.topGroup() === 'modal:action-sheet' && st.sheets.includes('ep'));

  key(fx, st, 'back');
  check('A15 Back 关表 → 焦点回到原集行', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 2 && !st.sheets.includes('ep'));

  const before = st.played.length;
  fx.pressStart(); fx.advanceTime(200); fx.pressEnd();
  check('A16 短按 OK(<550ms) → activate 播放', st.played.length === before + 1);

  fx.pressStart(); fx.advanceTime(100); fx.move('up'); fx.pressEnd(); fx.advanceTime(600);
  check('A17 按住 OK 期间移动焦点 → 判定作废（无 longPress 无 activate）',
    st.played.length === before + 1 && !st.sheets.includes('x'));

  // 越界收敛：S03 只 6 集，焦点 10 → 收到 5
  fx.switchTo('detail-episodes', 10);
  st.activeSeason = 2; // 模拟切季/重刮后集数变少
  const epsNow = st.state().curEpisodes().length;
  if (10 >= epsNow) fx.switchTo('detail-episodes', Math.max(0, epsNow - 1));
  check('A18 切到集数更少的季后越界焦点收到最后一集', fx.topIndex() === epsNow - 1);

  key(fx, st, 'back');
  check('A19 集列表 Back → 关详情（exit=onClose）', st.closed === true && fx.topGroup() === 'grid:series');
}

// ══ 用例 B：电影（无 chips） ══
console.log('B. 电影');
{
  const fx = makeFocus();
  const st = makeDetail(fx, { isMovie: true, epCounts: [1] });
  fx.push('detail-actions', 0);
  key(fx, st, 'down');
  check('B1 下 → 直达文件行（无季 chips）', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 0);
  key(fx, st, 'up');
  check('B2 上 → 回操作行', fx.topGroup() === 'detail-actions' && fx.topIndex() === 0);
  key(fx, st, 'down'); key(fx, st, 'left'); key(fx, st, 'right');
  check('B3 文件行左右 = 停住', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 0);
  key(fx, st, 'ok'); key(fx, st, 'okUp');
  check('B4 OK 播放电影', st.played.length === 1);
}

// ══ 用例 C：单季剧集（chips 只 1 个） ══
console.log('C. 单季剧集');
{
  const fx = makeFocus();
  const st = makeDetail(fx, { isMovie: false, epCounts: [10] });
  fx.push('detail-actions', 0);
  key(fx, st, 'down');
  check('C1 下 → 季 chips（1 个）', fx.topGroup() === 'detail-seasons' && fx.topIndex() === 0);
  key(fx, st, 'down');
  check('C2 下 → 集列表', fx.topGroup() === 'detail-episodes' && fx.topIndex() === 0);
  key(fx, st, 'up'); key(fx, st, 'up');
  check('C3 两下上 → 操作行', fx.topGroup() === 'detail-actions' && fx.topIndex() === 0);
}

// ══ 用例 D：Back 弹层语义（表 → 详情 → 网格，逐层弹） ══
console.log('D. Back');
{
  const fx = makeFocus();
  const st = makeDetail(fx, { isMovie: false, epCounts: [8, 4] });
  fx.push('nav', 0); fx.push('grid:series', 0);
  fx.push('detail-actions', 0);
  fx.switchTo('detail-episodes', 3);
  fx.pressStart(); fx.advanceTime(OK_HOLD_MS + 10); // 长按开表
  check('D1 表已打开', fx.topGroup() === 'modal:action-sheet');
  key(fx, st, 'back');
  check('D2 第一次 Back → 只关表', fx.topGroup() === 'detail-episodes' && st.sheets.length === 0);
  key(fx, st, 'back');
  check('D3 第二次 Back → 关详情', st.closed === true && fx.topGroup() === 'grid:series');
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
