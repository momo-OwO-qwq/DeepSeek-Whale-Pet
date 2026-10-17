'use strict'
// ---------------------------------------------------------------------------
// 自定义泡泡框（移植自上游 v0.4.0「自定义泡泡框」）
//
// 上游给泡泡加了「框」这一层：框库 / 真实预览 / 内容安全区 / 左右版。桌宠版
// 没有 webServer，因此这里只保留数据模型 + 消毒，纯函数、可直接单测：
//   · 内置框（classic / round / note / dashed / glass）由 CSS 绘制，零素材
//   · 用户框是上传的 PNG，落在 ~/.config/whale-pet/bubble-frames/<id>.png
//   · 每个框自带「安全区」safe = { x, y, w, h }，单位是泡泡画布（1026×700）的
//     归一化比例 —— 渲染层据此内缩文字/模块，保证不压到边框和尾巴
//   · tail 指示尾巴方向（left / right / none）；mirror 打开时整框水平翻转，
//     安全区同步镜像，避免内容留在被翻转掉的旧位置
//
// 配置结构（bubble-frame.json）：
//   { v:1, sel:'classic', mirror:false, safe:null|{x,y,w,h}, custom:[{id,name,format,safe,tail,createdAt}] }
//   safe === null 表示跟随框自带的安全区；否则是用户微调后的覆盖值。
// ---------------------------------------------------------------------------

const FRAME_VERSION = 1
const FRAME_MAX_BYTES = 4 * 1024 * 1024
const FRAME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 24
const TAILS = ['left', 'right', 'none']

// 经典 SVG 椭圆的包围盒（d="M 827 248 A 373 232 ..."，圆心 454,247，rx/ry 373/232，
// 线宽 18）。所有内置框都按这个盒子定位，保证「换框不换位置」——经典框和新框
// 的视觉边界完全重合，不会出现「经典框位置和其他框不一样」。
const FRAME_BOX = { x: 0.075, y: 0.02, w: 0.73, h: 0.665 }

// 内容安全区：中心 (43.4%, 35.5%)，比椭圆圆心 (44.25%, 35.3%) 略向左；
// 纵向对齐圆心附近（旧版 38% 偏低，表现为文字压在下半圆上）。
const FRAME_SAFE = { x: 0.134, y: 0.105, w: 0.60, h: 0.50 }

// 泡泡画布的归一化安全区默认值（尾巴在左侧，内容偏右）
const BUILTIN_FRAMES = [
  {
    id: 'classic', name: '经典泡泡', kind: 'classic', builtin: true, tail: 'left',
    safe: Object.assign({}, FRAME_SAFE), box: Object.assign({}, FRAME_BOX),
  },
  {
    id: 'round', name: '圆角框', kind: 'round', builtin: true, tail: 'left',
    safe: Object.assign({}, FRAME_SAFE), box: Object.assign({}, FRAME_BOX),
  },
  {
    id: 'note', name: '便签', kind: 'note', builtin: true, tail: 'none',
    safe: Object.assign({}, FRAME_SAFE), box: Object.assign({}, FRAME_BOX),
  },
  {
    id: 'dashed', name: '虚线框', kind: 'dashed', builtin: true, tail: 'none',
    safe: Object.assign({}, FRAME_SAFE), box: Object.assign({}, FRAME_BOX),
  },
  {
    id: 'glass', name: '毛玻璃', kind: 'glass', builtin: true, tail: 'right',
    safe: Object.assign({}, FRAME_SAFE), box: Object.assign({}, FRAME_BOX),
  },
]

const SAFE_MIN_W = 0.2
const SAFE_MIN_H = 0.2

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function numOr(v, def) {
  const n = Number(v)
  return isFinite(n) ? n : def
}

function sanitizeName(v, def) {
  const s = String(v === undefined || v === null ? '' : v).trim().slice(0, MAX_NAME)
  return s || def || '未命名框'
}

function isBuiltin(id) {
  return BUILTIN_FRAMES.some(function (f) { return f.id === id })
}

function builtinDef(id) {
  for (let i = 0; i < BUILTIN_FRAMES.length; i++) {
    if (BUILTIN_FRAMES[i].id === id) return BUILTIN_FRAMES[i]
  }
  return null
}

// 安全区消毒：x/y ∈ [0,0.85]，w/h ∈ [0.2,1]，且 x+w / y+h 不越界。
// 越界时按「保尺寸、挤回边界」处理，保证内容永远在画布内。
function sanitizeSafe(raw, fallback) {
  const base = fallback && typeof fallback === 'object' ? fallback : { x: 0.12, y: 0.1, w: 0.66, h: 0.5 }
  const src = raw && typeof raw === 'object' ? raw : {}
  const w = clamp(numOr(src.w, base.w), SAFE_MIN_W, 1)
  const h = clamp(numOr(src.h, base.h), SAFE_MIN_H, 1)
  const x = clamp(numOr(src.x, base.x), 0, 1 - w)
  const y = clamp(numOr(src.y, base.y), 0, 1 - h)
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) }
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}

function sanitizeTail(v, def) {
  const t = String(v || '')
  if (TAILS.indexOf(t) !== -1) return t
  return def || 'left'
}

function newId(prefix, rnd) {
  const random = typeof rnd === 'function' ? rnd : Math.random
  return prefix + Date.now().toString(36) + '_' + random().toString(36).slice(2, 8)
}

function defaultFrame() {
  return { v: FRAME_VERSION, sel: 'classic', mirror: false, safe: null, custom: [] }
}

// 整份配置消毒：sel 必须指向已存在的框（内置或自定义），否则回退 classic；
// 自定义框重复 id / 非法 id 直接丢弃。
function sanitize(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const out = defaultFrame()
  const list = Array.isArray(d.custom) ? d.custom : []
  const seen = {}
  for (let i = 0; i < list.length && out.custom.length < 40; i++) {
    const f = list[i] && typeof list[i] === 'object' ? list[i] : {}
    const id = String(f.id || '')
    if (!FRAME_ID_RE.test(id) || seen[id] || isBuiltin(id)) continue
    seen[id] = true
    const format = f.format === 'gif' ? 'gif' : 'png'
    out.custom.push({
      id: id,
      name: sanitizeName(f.name, '未命名框'),
      format: format,
      tail: sanitizeTail(f.tail, 'none'),
      safe: sanitizeSafe(f.safe, null),
      createdAt: Number(f.createdAt) || 0,
    })
  }
  const sel = String(d.sel || '')
  const valid = isBuiltin(sel) || out.custom.some(function (f) { return f.id === sel })
  out.sel = valid ? sel : 'classic'
  out.mirror = d.mirror === true
  out.safe = d.safe === null || d.safe === undefined ? null : sanitizeSafe(d.safe, null)
  return out
}

// 当前生效的框：内置定义或用户条目；id 失效时回退 classic
function resolve(cfg) {
  const c = sanitize(cfg)
  const b = builtinDef(c.sel)
  if (b) {
    return {
      id: b.id, name: b.name, builtin: true, kind: b.kind,
      tail: b.tail, safe: c.safe || b.safe, box: b.box, mirror: c.mirror,
    }
  }
  const u = c.custom.filter(function (f) { return f.id === c.sel })[0]
  if (!u) {
    const fb = BUILTIN_FRAMES[0]
    return { id: fb.id, name: fb.name, builtin: true, kind: fb.kind, tail: fb.tail, safe: c.safe || fb.safe, box: fb.box, mirror: c.mirror }
  }
  // 图片框铺满画布，没有独立框盒 → box 用整张画布
  return { id: u.id, name: u.name, builtin: false, kind: 'image', format: u.format, tail: u.tail, safe: c.safe || u.safe, box: { x: 0, y: 0, w: 1, h: 1 }, mirror: c.mirror }
}

// 镜像后的安全区：水平翻转（x' = 1 - x - w），尾巴方向同步换边
function mirrorSafe(safe) {
  return { x: round4(1 - safe.x - safe.w), y: safe.y, w: safe.w, h: safe.h }
}

// 渲染层需要的最终几何：镜像时给出翻转后的安全区与尾巴
function effective(cfg) {
  const r = resolve(cfg)
  const safe = r.mirror ? mirrorSafe(r.safe) : r.safe
  // 框盒也要镜像，否则「镜像」只把文字翻到另一边、框还留在原位（文字与框脱开）
  const box = (r.mirror && r.box) ? { x: round4(1 - r.box.x - r.box.w), y: r.box.y, w: r.box.w, h: r.box.h } : r.box
  const tail = r.mirror ? (r.tail === 'left' ? 'right' : (r.tail === 'right' ? 'left' : 'none')) : r.tail
  return { id: r.id, name: r.name, builtin: r.builtin, kind: r.kind, format: r.format || 'png', safe: safe, box: box, tail: tail, mirror: r.mirror }
}

// 框库列表（给设置页）：内置在前，自定义在后
function list(cfg) {
  const c = sanitize(cfg)
  const out = BUILTIN_FRAMES.map(function (f) {
    return { id: f.id, name: f.name, builtin: true, kind: f.kind, tail: f.tail, safe: f.safe }
  })
  for (let i = 0; i < c.custom.length; i++) {
    const f = c.custom[i]
    out.push({ id: f.id, name: f.name, builtin: false, kind: 'image', format: f.format, tail: f.tail, safe: f.safe })
  }
  return out
}

// 用户框文件路径（仅 png/gif）
function frameFilePath(dir, id, format) {
  if (!FRAME_ID_RE.test(String(id || ''))) return null
  return require('path').join(dir, id + (format === 'gif' ? '.gif' : '.png'))
}

module.exports = {
  FRAME_VERSION, FRAME_MAX_BYTES, MAX_NAME, TAILS, BUILTIN_FRAMES, FRAME_BOX, FRAME_SAFE,
  isBuiltin, builtinDef, sanitize, sanitizeSafe, sanitizeName, sanitizeTail,
  newId, defaultFrame, resolve, effective, mirrorSafe, list, frameFilePath,
}
