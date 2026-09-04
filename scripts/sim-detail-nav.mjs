// 状态机模拟：详情页全导航矩阵（剧集多季 / 剧集单季无季面板 / 电影）
// 直接复刻 focus.ts move() + SeriesDetail.tsx 三个 leave 的行为，不 import 源码
//（源码是 React 组件，node 里跑不动），手抄逻辑保持与源码逐行对应。

const registry = new Map();
function makeStackStore() {
  let stack = [];
  return {
    get: () => stack,
    push: (group, index = 0) => { stack = [...stack, { group, index }]; },
    switchTo: (group, index = 0) => {
      const target = registry.has(group) ? group : 'nav';
      stack = stack.length ? [...stack.slice(0, -1), { group: target, index }] : [{ group: target, index }];
    },
    back: () => { if (stack.length <= 1) return false; stack = stack.slice(0, -1); return true; },
  };
}

// ── 模拟一次详情页会话。countMin/countMax 覆盖边界项（0 / 中间 / 最后）──
function simulate(label, { isMovie, seasonCount, epCounts }) {
  const store = makeStackStore();
  let activeSeason = 0; // 影片数据里当前季的索引（对应源码 season memo 回退逻辑）
  const state = {
    lastHeroRow: 0, lastSeasonRow: 0, lastEpisodeRow: 0,
    heroFocused: -1, seasonsFocused: -1, episodesFocused: -1,
  };
  const totalEps = () => epCounts[activeSeason] ?? 0;
  const panelSeasons = !isMovie && seasonCount > 0; // 季面板是否渲染

  const heroLeave = (dir) => {
    if (dir === 'right') {
      if (!isMovie && seasonCount > 0) store.switchTo('detail-seasons', Math.min(state.lastSeasonRow, seasonCount - 1));
      else if (totalEps() > 0) store.switchTo('detail-episodes', Math.min(state.lastEpisodeRow, totalEps() - 1));
    }
  };
  const seasonsLeave = (dir) => {
    if (dir === 'left') store.switchTo('detail-hero', state.lastHeroRow);
    else if (dir === 'right' && totalEps() > 0) store.switchTo('detail-episodes', Math.min(state.lastEpisodeRow, totalEps() - 1));
    else if (dir === 'down' && totalEps() > 0) store.switchTo('detail-episodes', Math.min(state.lastEpisodeRow, totalEps() - 1));
  };
  const episodesLeave = (dir) => {
    if (dir === 'left') {
      if (activeSeason > 0) { activeSeason--; store.switchTo('detail-episodes', 0); }
      else if (panelSeasons) store.switchTo('detail-seasons', Math.min(state.lastSeasonRow, seasonCount - 1));
      else store.switchTo('detail-hero', state.lastHeroRow);
    } else if (dir === 'right') {
      if (activeSeason < seasonCount - 1) { activeSeason++; store.switchTo('detail-episodes', 0); }
    } else if (dir === 'up') {
      if (panelSeasons) store.switchTo('detail-seasons', Math.min(state.lastSeasonRow, seasonCount - 1));
      else store.switchTo('detail-hero', state.lastHeroRow);
    }
  };

  registry.set('detail-hero', {
    count: 4, cols: 1,
    leave: heroLeave,
    onIndex: (i) => { state.heroFocused = i; if (i >= 0) state.lastHeroRow = i; },
  });
  registry.set('detail-seasons', {
    count: panelSeasons ? seasonCount : 0, cols: 1,
    leave: seasonsLeave,
    onIndex: (i) => { state.seasonsFocused = i; if (i >= 0) state.lastSeasonRow = i; },
  });
  registry.set('detail-episodes', {
    count: totalEps(), cols: 1,
    leave: episodesLeave,
    onIndex: (i) => { state.episodesFocused = i; if (i >= 0) state.lastEpisodeRow = i; },
  });

  // ── move()：照抄 focus.ts（含 verticalArea 特例）──
  function refreshCounts() {
    registry.get('detail-episodes').count = totalEps();
    registry.get('detail-seasons').count = panelSeasons ? seasonCount : 0;
  }
  function move(dir) {
    refreshCounts();
    const top = store.get()[store.get().length - 1];
    if (!top) return 'EMPTY_STACK';
    const opts = registry.get(top.group);
    if (!opts) return 'UNREGISTERED:' + top.group;
    if (opts.count <= 0) { opts.leave?.(dir, -1); return; }
    if (top.index == null) { opts.onIndex?.(0); return; }
    const verticalArea = ['detail-hero', 'detail-seasons', 'detail-episodes'].includes(top.group);
    if (verticalArea && (dir === 'left' || dir === 'right')) { opts.leave?.(dir, top.index); return; }
    const { count, cols = count } = opts;
    const index = top.index;
    let next = index, crossed = false;
    if (cols > 1) { /* 三组都是 cols=1，走不到 */ }
    else {
      if (dir === 'up') { if (index > 0) next = index - 1; else crossed = true; }
      else if (dir === 'down') { if (index < count - 1) next = index + 1; else crossed = true; }
      else crossed = true; // verticalArea 已把 left/right 截走，cols=1 下到不了这
    }
    if (crossed) { opts.leave?.(dir, index); return; }
    if (next !== index) {
      store.get().splice(store.get().length - 1, 1, { group: top.group, index: next });
      opts.onIndex?.(next);
    }
  }

  const failures = [];
  const show = () => {
    const top = store.get()[store.get().length - 1];
    return `${top.group}[${top?.index ?? 'null'}] S${activeSeason + 1}`;
  };
  const step = (dir, expect) => {
    move(dir);
    const got = show();
    const ok = expect === null ? true : got === expect;
    if (!ok) failures.push(`${dir}: expected ${expect}, got ${got}`);
    return got;
  };

  // 场景进入：push detail-hero 0（每个用例前重置行记忆，避免状态跨用例泄漏）
  state.lastHeroRow = 0; state.lastSeasonRow = 0; state.lastEpisodeRow = 0;
  store.push('detail-hero', 0); registry.get('detail-hero').onIndex?.(0);

  // ── 矩阵：每组 × 每方向，从每个边界位置出发 ──
  const dirs = ['up', 'down', 'left', 'right'];

  // 1) hero 四个位置 × 四方向
  for (let h = 0; h < 4; h++) {
    for (const d of dirs) {
      store.get().splice(-1, 1, { group: 'detail-hero', index: h });
      registry.get('detail-hero').onIndex?.(h);
      move(d);
      const top = store.get()[store.get().length - 1];
      const invisible = top.group === 'detail-seasons' && !panelSeasons;
      if (invisible) failures.push(`hero[${h}] ${d}: 焦点进不可见季面板 → ${show()}`);
      if (top.group === 'detail-hero' && top.index == null) failures.push(`hero[${h}] ${d}: index 变 null`);
    }
  }

  // 2) 季列表（若渲染）：首/中/末项 × 四方向
  if (panelSeasons) {
    for (const s of [0, Math.floor(seasonCount / 2), seasonCount - 1]) {
      for (const d of dirs) {
        activeSeason = 0; // leave 不改 activeSeason（切季只发生在 episodes）
        store.get().splice(-1, 1, { group: 'detail-seasons', index: s });
        registry.get('detail-seasons').onIndex?.(s);
        move(d);
        const top = store.get()[store.get().length - 1];
        if (top.group === 'detail-hero' && top.index == null) failures.push(`seasons[${s}] ${d}: hero index null`);
        // right 必须离开季列表（集列表非空时）；down 行内下移是正常行为，
        // 只有末行 down 越界才进集列表（TV 惯例：行内移动优先）
        if (d === 'right' && totalEps() > 0 && top.group === 'detail-seasons') {
          failures.push(`seasons[${s}] ${d}: 没进集列表（停在 ${show()}）`);
        }
        if (d === 'down' && s === seasonCount - 1 && totalEps() > 0 && top.group === 'detail-seasons') {
          failures.push(`seasons[末行] down: 越界没进集列表（停在 ${show()}）`);
        }
        if (d === 'left' && top.group !== 'detail-hero') failures.push(`seasons[${s}] left: 没回左栏（${show()}）`);
      }
    }
  }

  // 3) 集列表：首/中/末项 × 四方向，三个季节档位（第一季/中间季/最后一季）
  const seasonsToProbe = [...new Set([0, Math.floor(seasonCount / 2), seasonCount - 1])];
  for (const s0 of seasonsToProbe) {
    for (const e of [0, Math.floor(Math.max(1, totalEps()) / 2), totalEps() - 1]) {
      if (e < 0 || e >= totalEps()) continue;
      for (const d of dirs) {
        activeSeason = s0;
        store.get().splice(-1, 1, { group: 'detail-episodes', index: e });
        registry.get('detail-episodes').onIndex?.(e);
        move(d);
        const top = store.get()[store.get().length - 1];
        if (top.group === 'detail-seasons' && !panelSeasons) failures.push(`eps[S${s0 + 1}E${e + 1}] ${d}: 进不可见季面板 → ${show()}`);
        if (top.index != null && top.index < 0) failures.push(`eps[S${s0 + 1}E${e + 1}] ${d}: 负索引`);
        if (d === 'right' && s0 < seasonCount - 1 && activeSeason === s0) {
          failures.push(`eps[S${s0 + 1}E${e + 1}] right: 没切到下一季（active 仍 S${activeSeason + 1}）`);
        }
        if (d === 'left' && s0 > 0 && activeSeason === s0) {
          failures.push(`eps[S${s0 + 1}E${e + 1}] left: 没切上一季（active 仍 S${activeSeason + 1}）`);
        }
      }
    }
  }

  // 4) 连贯路径冒烟：hero right → seasons down → eps；eps left 回 seasons；left 再回 hero
  // （重置行记忆 = 模拟用户刚进页面的状态，矩阵段的探测值不能带进冒烟）
  activeSeason = 0;
  state.lastHeroRow = 0; state.lastSeasonRow = 0; state.lastEpisodeRow = 0;
  store.get().splice(-1, 1, { group: 'detail-hero', index: 0 });
  registry.get('detail-hero').onIndex?.(0);
  let cur = show();
  cur = step('right', panelSeasons ? 'detail-seasons[0] S1' : (totalEps() > 0 ? `detail-episodes[0] S1` : cur));
  if (panelSeasons) cur = step('down', null);
  if (cur.startsWith('detail-episodes')) {
    step('left', null);
    const top = store.get()[store.get().length - 1];
    if (panelSeasons && top.group !== 'detail-seasons') failures.push(`冒烟: eps left 没回季列表（${show()}）`);
    if (!panelSeasons && top.group !== 'detail-hero') failures.push(`冒烟: eps left 没回左栏（${show()}）`);
    step('left', null); // 季列表 left → hero
  }

  console.log(`── ${label} ──  ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  for (const f of failures) console.log('   ✗ ' + f);
  return failures.length;
}

let bad = 0;
// 剧集 3 季，集数 8/6/10（首/中/末季都能探测）
bad += simulate('剧集·3季(8/6/10集)', { isMovie: false, seasonCount: 3, epCounts: [8, 6, 10] });
// 剧集 1 季（季面板渲染但只有一行）
bad += simulate('剧集·单季(12集)', { isMovie: false, seasonCount: 1, epCounts: [12] });
// 电影：后端 1 季 1 集，季面板不渲染
bad += simulate('电影·1集(无季面板)', { isMovie: true, seasonCount: 1, epCounts: [1] });
// 边界：剧集无季无集（数据异常形态）
bad += simulate('剧集·0季0集', { isMovie: false, seasonCount: 0, epCounts: [] });
// 边界：中间季为空（切到 S2 后集列表 count=0，方向键应走 leave(-1) 不崩不卡）
bad += simulate('剧集·3季·中空(6/0/4集)', { isMovie: false, seasonCount: 3, epCounts: [6, 0, 4] });

process.exit(bad === 0 ? 0 : 1);
