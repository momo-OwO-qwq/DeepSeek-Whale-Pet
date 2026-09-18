'use strict'
// ---------------------------------------------------------------------------
// 自定义泡泡配置（移植自上游 assets/whale-widget.js，v0.3.5）
//
// 上游把泡泡配置放在 localStorage / .dshw-bubble.json，前端直读。桌宠版没有
// webServer，因此这里把「配置模型 + 消毒 + 迁移 + 抽样」抽成纯 Node 模块：
//   · 主进程负责持久化（~/.config/whale-pet/bubble.json）与广播
//   · 渲染进程只消费 sanitize 后的配置，不再自己解析脏数据
//   · 全部逻辑无副作用，可直接被 test/unit.test.js 覆盖
//
// 配置结构（与上游 v:1 对齐，字段名保持一致以便日后同步）：
//   {
//     v: 1,
//     items: [ item, ... ],        // 点击序列（按顺序推进）
//     lib:   [ { id, name, module } ], // 模块库（另存复用）
//     tapAdvance: false            // 点按角色推进队列
//   }
//
// item 三种形态（对应上游 kind）：
//   { kind: 'normal' }                      内置默认泡（余额 + 今日已用）
//   { kind: 'random' }                      随机台词泡
//   { kind: 'custom', modules: [module, ...] } 自定义模块泡
//   { kind: 'choice', options: [ { w, item }, ... ] } A/B 并列加权选择
// ---------------------------------------------------------------------------

const BUBBLE_VERSION = 1

// 每行模块数上限 / 泡泡行数上限（上游 BUBBLE_PV_MOD_MAX / BUBBLE_PV_ROW_MAX）
const MOD_MAX = 6
const ROW_MAX = 6
// 一个泡泡内只允许一个图片类模块，且图片类模块独占一整行（上游 bubbleItemHasImage）
const IMG_MAX = 1

// 模块类型（上游 type 字段）
const MODULE_TYPES = ['text', 'link', 'random', 'image', 'randimg', 'balance', 'today', 'peak', 'cost']
// 图片类模块：独占一行，且一个泡泡只能有一个
const IMG_TYPES = ['image', 'randimg']

// 字号档位：上游 bubbleModuleFontU —— 1..50 线性映射到 40u..240u（相对 --wp-u 倍数）
const SIZE_MIN = 1
const SIZE_MAX = 50
const SIZE_U_MIN = 40
const SIZE_U_MAX = 240
const DEFAULT_SIZE = 6

// 内置跑马灯渐变（上游 dshwv-rgb-* / dshwv-bgrgb-* 的键）
const GRADIENT_KEYS = [
  'rainbow', 'candy', 'rouge', 'bamboo', 'aurora', 'deepsea', 'sunset',
  'forest', 'champagne', 'lavender', 'mint', 'lava', 'galaxy', 'ink', 'indigo',
]
// 占位符（上游模板用英文 key，渲染时替换）
const PLACEHOLDERS = {
  balance: '{balance}',
  today: '{today}',
  status: '{status}',
  countdown: '{countdown}',
  cost: '{cost}',
  quota: '{quota}',
  quotaUsed: '{quota_used}',
  quotaLeft: '{quota_left}',
  quotaTotal: '{quota_total}',
  quotaReset: '{quota_reset}',
}

// 新建文本模块默认加粗（上游：m.type==='text' && m.bold===undefined → true）
function isImgMod(m) {
  return !!m && IMG_TYPES.indexOf(m.type) !== -1
}

// 字号档位 → u 值（上游 bubbleModuleFontU）
function moduleFontU(level) {
  let n = Number(level)
  if (!isFinite(n)) n = DEFAULT_SIZE
  n = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(n)))
  return Math.round(SIZE_U_MIN + (n - 1) * (SIZE_U_MAX - SIZE_U_MIN) / (SIZE_MAX - SIZE_MIN))
}

// 并列候选权重：至少 1 的整数（上游 bubbleChoiceWeight）
function choiceWeight(o) {
  return Math.max(1, Math.round(Number(o && o.w) || 1))
}

function clampStr(v, max) {
  return String(v === undefined || v === null ? '' : v).slice(0, max)
}

function isHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())
}

function numOr(v, def) {
  const n = Number(v)
  return isFinite(n) ? n : def
}

// ---------------------------------------------------------------- 模块消毒
// 只保留已知字段，并把每个字段拉回合法范围；未知类型回退为文本模块。
function sanitizeModule(raw) {
  const m = raw && typeof raw === 'object' ? raw : {}
  let type = String(m.type || 'text')
  if (MODULE_TYPES.indexOf(type) === -1) type = 'text'

  const out = { type: type }
  if (type === 'text' || type === 'link') {
    out.text = clampStr(m.text, 200)
    if (type === 'link') out.href = clampStr(m.href, 500)
  }
  if (type === 'random') {
    // 随机语句：多条句子带权重，每次抽 1 条且不连续重复
    const src = Array.isArray(m.lines) ? m.lines : []
    out.lines = src.slice(0, 60).map(function (l) {
      if (typeof l === 'string') return { t: clampStr(l, 40), w: 1 }
      const o = l && typeof l === 'object' ? l : {}
      return { t: clampStr(o.t, 40), w: Math.max(1, Math.round(numOr(o.w, 1))) }
    }).filter(function (l) { return l.t })
  }
  if (type === 'image' || type === 'randimg') {
    if (type === 'image') {
      out.imgId = clampStr(m.imgId, 80)
    } else {
      const src = Array.isArray(m.imgs) ? m.imgs : []
      out.imgs = src.slice(0, 40).map(function (im) {
        if (typeof im === 'string') return { id: clampStr(im, 80), w: 1 }
        const o = im && typeof im === 'object' ? im : {}
        return { id: clampStr(o.id, 80), w: Math.max(1, Math.round(numOr(o.w, 1))) }
      }).filter(function (im) { return im.id })
    }
    out.imgScale = Math.max(0.2, Math.min(4, numOr(m.imgScale, 1)))
  }
  if (type === 'balance' || type === 'today' || type === 'peak' || type === 'cost') {
    // 内容模板：留空则该模块渲染为空（上游 tpl）
    out.tpl = clampStr(m.tpl, 120)
    // 峰谷模块样式：status | countdown | simple 等
    if (type === 'peak') out.peakStyle = clampStr(m.peakStyle, 20) || 'status'
  }

  // 字形（逐模块独立；行级可覆盖）
  if (m.size !== undefined) out.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(numOr(m.size, DEFAULT_SIZE))))
  let color = isHexColor(m.color) ? m.color.trim() : ''
  if (color) out.color = color
  // 跑马灯文字色 / 底色 / 底色跑马灯：与纯色互不冲突
  if (typeof m.rgb === 'string' && GRADIENT_KEYS.indexOf(m.rgb) !== -1) out.rgb = m.rgb
  let bg = isHexColor(m.bg) ? m.bg.trim() : ''
  if (bg) out.bg = bg
  if (typeof m.bgrgb === 'string' && GRADIENT_KEYS.indexOf(m.bgrgb) !== -1) out.bgrgb = m.bgrgb
  // 文本/随机语句默认加粗（上游行为）
  if (m.bold === undefined) out.bold = (type === 'text' || type === 'random')
  else out.bold = !!m.bold
  out.italic = !!m.italic
  out.ul = !!m.ul
  // 文本自动换行（上游 wrap；用于长句随机台词）
  if (type === 'text' || type === 'random') out.wrap = !!m.wrap
  // 行键（上游 bubbleRowKeyOf）：正整数 = 与同键模块同处一行；无键 = 自成一行。
  // 归一化由 rowsOf/rowsFlat/rowsCanon 负责，这里只保留合法值。
  const rk = Number(m.row)
  if (isFinite(rk) && Math.round(rk) === rk && rk > 0) out.row = Math.round(rk)
  return out
}

// 模块的行键；非法/缺失返回 null（上游 bubbleRowKeyOf）
function rowKeyOf(m) {
  const n = m && m.row
  if (typeof n === 'number' && isFinite(n) && Math.round(n) === n && n > 0) return n
  return null
}

// ---------------------------------------------------------------- 行归组
// 上游 bubbleRowsOf：按 row 键把平铺 modules[] 归成视觉行；图片类模块独占一整行，
// 并打断与前后模块的行合并。编辑器与渲染层共用同一套规则，避免两边判定不一致。
function rowsOf(modules) {
  const list = Array.isArray(modules) ? modules : []
  const out = []
  let cur = null
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {}
    if (isImgMod(m)) {
      out.push([m])
      cur = null
      continue
    }
    const key = rowKeyOf(m)
    if (cur && cur.key !== null && key === cur.key) {
      cur.row.push(m)
      continue
    }
    cur = { key: key, row: [m] }
    out.push(cur.row)
  }
  return out.slice(0, ROW_MAX)
}

// 上游 bubbleRowsFlat：行数组 → 平铺 modules[]，同行的模块写同行键；
// 单模块行与图片行不写键（避免留下无意义的行号）。
function rowsFlat(rows) {
  const out = []
  const list = Array.isArray(rows) ? rows : []
  for (let r = 0; r < list.length; r++) {
    const row = list[r]
    if (!row || !row.length) continue
    const multi = row.length > 1
    for (let i = 0; i < row.length; i++) {
      const m = row[i]
      if (!m || typeof m !== 'object') continue
      if (multi) m.row = r + 1
      else delete m.row
      out.push(m)
    }
  }
  return out
}

// 上游 bubbleRowsCanon：就地规范化 modules[]，以当前分组为准重写/清除行键。
function rowsCanon(modules) {
  if (!Array.isArray(modules)) return modules
  const flat = rowsFlat(rowsOf(modules))
  modules.length = 0
  for (let i = 0; i < flat.length; i++) modules.push(flat[i])
  return modules
}

// 把模块并入目标行首/尾（上游编辑器拖拽的两种落点）。返回新的行数组或 null（超限）。
function mergeIntoRow(rows, mod, targetIdx, atStart) {
  const list = Array.isArray(rows) ? rows.map(function (r) { return r.slice() }) : []
  if (targetIdx < 0 || targetIdx >= list.length) return null
  const tgt = list[targetIdx]
  // 图片类模块独占一行：不能与任何其它模块同行
  if (isImgMod(mod) || (tgt && tgt.length && isImgMod(tgt[0]))) return null
  if (tgt.length >= MOD_MAX) return null
  if (atStart) tgt.unshift(mod)
  else tgt.push(mod)
  return list
}

// 拆行：把某一行里的一个模块另起一行（插到该行之后）。
function splitRow(rows, rowIdx, modIdx) {
  const list = Array.isArray(rows) ? rows.map(function (r) { return r.slice() }) : []
  if (rowIdx < 0 || rowIdx >= list.length) return null
  const row = list[rowIdx]
  if (!row || modIdx < 0 || modIdx >= row.length) return null
  if (row.length < 2) return null
  if (list.length >= ROW_MAX) return null
  const moved = row.splice(modIdx, 1)[0]
  list.splice(rowIdx + 1, 0, [moved])
  return list
}

// 整行排序：把 fromIdx 行移到 toIdx 位置。
function moveRow(rows, fromIdx, toIdx) {
  const list = Array.isArray(rows) ? rows.map(function (r) { return r.slice() }) : []
  if (fromIdx < 0 || fromIdx >= list.length) return null
  if (toIdx < 0 || toIdx >= list.length) return null
  if (fromIdx === toIdx) return list
  const moved = list.splice(fromIdx, 1)[0]
  list.splice(toIdx, 0, moved)
  return list
}

// 一个泡泡是否已含图片类模块（用于「只能有一个图片模块」校验）
function itemHasImage(modules) {
  const list = Array.isArray(modules) ? modules : []
  for (let i = 0; i < list.length; i++) if (isImgMod(list[i])) return true
  return false
}

// 图片模块数量（> IMG_MAX 即非法）
function countImages(modules) {
  const list = Array.isArray(modules) ? modules : []
  let n = 0
  for (let i = 0; i < list.length; i++) if (isImgMod(list[i])) n++
  return n
}

// ---------------------------------------------------------------- 条目消毒
function sanitizeItem(raw, depth) {
  const d = depth || 0
  const it = raw && typeof raw === 'object' ? raw : {}
  const kind = String(it.kind || 'normal')

  if (kind === 'choice' && d < 2) {
    // A/B 并列：上游最多取 2 个候选（applyBubbleCfgSeq 里 ci < 2）
    const src = Array.isArray(it.options) ? it.options : []
    const options = []
    for (let i = 0; i < src.length && i < 2; i++) {
      const o = src[i] && typeof src[i] === 'object' ? src[i] : {}
      options.push({ w: choiceWeight(o), item: sanitizeItem(o.item, d + 1) })
    }
    if (options.length) return { kind: 'choice', options: options }
    return { kind: 'normal' }
  }
  if (kind === 'custom') {
    const mods = Array.isArray(it.modules) ? it.modules.slice(0, ROW_MAX * MOD_MAX) : []
    return { kind: 'custom', modules: mods.map(sanitizeModule) }
  }
  if (kind === 'random') return { kind: 'random' }
  return { kind: 'normal' }
}

function sanitizeLib(raw) {
  const src = Array.isArray(raw) ? raw : []
  const out = []
  let seq = 0
  for (let i = 0; i < src.length && out.length < 60; i++) {
    const it = src[i] && typeof src[i] === 'object' ? src[i] : {}
    if (!it.module) continue
    seq++
    out.push({
      id: clampStr(it.id, 60) || ('bmod_' + seq.toString(36)),
      name: clampStr(it.name, 20) || ('模块' + seq),
      module: sanitizeModule(it.module),
    })
  }
  return out
}

// 整体消毒（读盘后 / 写入前统一走这里）
function sanitize(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const items = Array.isArray(d.items) ? d.items.slice(0, 30).map(function (it) { return sanitizeItem(it, 0) }) : []
  return {
    v: BUBBLE_VERSION,
    items: items,
    lib: sanitizeLib(d.lib),
    tapAdvance: d.tapAdvance === true,
  }
}

// 默认配置（等同「上游未配置」：items 为空 → 渲染层回退内置序列）
function defaults() {
  return { v: BUBBLE_VERSION, items: [], lib: [], tapAdvance: false }
}

// ---------------------------------------------------------------- 抽样
// 加权抽一个候选泡（上游 bubblePickChoiceStep：每轮独立抽，不记忆上次）
function pickChoice(options, rnd) {
  const list = Array.isArray(options) ? options : []
  if (!list.length) return null
  const random = typeof rnd === 'function' ? rnd : Math.random
  let total = 0
  for (let i = 0; i < list.length; i++) total += choiceWeight(list[i])
  const r = random() * total
  let acc = 0
  for (let j = 0; j < list.length; j++) {
    acc += choiceWeight(list[j])
    if (r < acc) return (list[j] && list[j].item) || null
  }
  const last = list[list.length - 1]
  return (last && last.item) || null
}

// 加权抽一行随机语句，避免与上一句连续重复（上游 pickRandomLines 的「不连续重复」）
function pickLine(lines, lastText, rnd) {
  const list = (Array.isArray(lines) ? lines : []).filter(function (l) { return l && l.t })
  if (!list.length) return ''
  const random = typeof rnd === 'function' ? rnd : Math.random
  let pool = list
  if (list.length > 1 && lastText) {
    const filtered = list.filter(function (l) { return l.t !== lastText })
    if (filtered.length) pool = filtered
  }
  let total = 0
  for (let i = 0; i < pool.length; i++) total += Math.max(1, Math.round(Number(pool[i].w) || 1))
  const r = random() * total
  let acc = 0
  for (let j = 0; j < pool.length; j++) {
    acc += Math.max(1, Math.round(Number(pool[j].w) || 1))
    if (r < acc) return pool[j].t
  }
  return pool[pool.length - 1].t
}

// 加权抽一张随机图片，避免与上一张连续重复（语义同上）
function pickImage(imgs, lastId, rnd) {
  const list = (Array.isArray(imgs) ? imgs : []).filter(function (im) { return im && im.id })
  if (!list.length) return ''
  const random = typeof rnd === 'function' ? rnd : Math.random
  let pool = list
  if (list.length > 1 && lastId) {
    const filtered = list.filter(function (im) { return im.id !== lastId })
    if (filtered.length) pool = filtered
  }
  let total = 0
  for (let i = 0; i < pool.length; i++) total += Math.max(1, Math.round(Number(pool[i].w) || 1))
  const r = random() * total
  let acc = 0
  for (let j = 0; j < pool.length; j++) {
    acc += Math.max(1, Math.round(Number(pool[j].w) || 1))
    if (r < acc) return pool[j].id
  }
  return pool[pool.length - 1].id
}

// ---------------------------------------------------------------- 点击推进状态机
// 严格照抄上游 whaleClick + bubbleShowSeqNext + bubbleNext 的语义。
//
// ⚠️ 关键：bubbleSeqIdx 是「**显示时**自增」的（bubbleShowSeqNext 内 `bubbleSeqIdx++`），
// 不是「下次点击时自增」。因此 idx 的语义是「下一条待显示的序号」，而 `idx <= 1`
// 恰好表示「当前正显示第 1 项」。这两点决定了下面的分支，不能凭直觉改写。
//
// 返回 { idx, show, act }：
//   act: 'start'  从第 1 项重新开始（开新轮）
//        'next'   往后推进一项
//        'reset'  已在第 1 项 → 只续时，不换内容
//        'close'  已是最后一项 → 收起泡泡
//        'ignore' 非手动轮 / 不在显示中 → 不动作
function advance(state, tapAdvance, total, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const shown = o.shown !== false
  const roundOn = o.roundOn !== false
  const n = Math.max(0, Number(total) || 0)
  const idx = Math.max(0, Number(state && state.idx) || 0)

  if (!shown) return { idx: 0, show: true, act: 'start' }
  if (tapAdvance) {
    // 点按推进：还有下一项就推进，否则收起
    if (roundOn && idx < n) return { idx: idx, show: true, act: 'next' }
    return { idx: 0, show: false, act: 'close' }
  }
  if (!roundOn) return { idx: idx, show: true, act: 'ignore' }
  // idx <= 1 表示当前正显示第 1 项 → 只续时
  if (idx <= 1) return { idx: idx, show: true, act: 'reset' }
  // 第 2 项及以后 → 回到序列开头
  return { idx: 0, show: true, act: 'start' }
}

// 解析第 idx 项为「可渲染场景」（choice→按权重落地成具体 item）
function resolveStep(items, idx, rnd) {
  const list = Array.isArray(items) ? items : []
  if (idx < 0 || idx >= list.length) return null
  const it = list[idx]
  if (it && it.kind === 'choice') {
    const picked = pickChoice(it.options, rnd)
    return picked || { kind: 'normal' }
  }
  return it || { kind: 'normal' }
}

// 占位符替换：模板里的 {balance} 等按 values 表替换；未知占位符原样保留
function renderTemplate(tpl, values) {
  const s = String(tpl === undefined || tpl === null ? '' : tpl)
  const v = values && typeof values === 'object' ? values : {}
  return s.replace(/\{([a-z_]+)\}/g, function (all, key) {
    return Object.prototype.hasOwnProperty.call(v, key) ? String(v[key]) : all
  })
}

module.exports = {
  BUBBLE_VERSION, MOD_MAX, ROW_MAX, IMG_MAX, MODULE_TYPES, IMG_TYPES,
  SIZE_MIN, SIZE_MAX, DEFAULT_SIZE, GRADIENT_KEYS, PLACEHOLDERS,
  isImgMod, rowKeyOf, moduleFontU, choiceWeight, sanitizeModule,
  rowsOf, rowsFlat, rowsCanon, mergeIntoRow, splitRow, moveRow,
  itemHasImage, countImages, sanitizeItem, sanitizeLib, sanitize, defaults,
  pickChoice, pickLine, pickImage, advance, resolveStep, renderTemplate,
}
