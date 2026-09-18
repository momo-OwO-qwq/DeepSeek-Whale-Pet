'use strict'
// ---------------------------------------------------------------------------
// 拖拽/定位的纯几何：把「可见鲸鱼矩形」换算成窗口可停放范围。
//
// 抽成独立模块的原因：
//   1. main.js 依赖 electron，无法在纯 Node 测试里 require —— 而这些公式正是
//      「缩放后空气墙」的出没地，必须有回归护栏。
//   2. 主进程（拖拽钳制）与渲染进程（settlePos 钳制）需要**同一套**规则，
//      否则两边各算各的会互相打架。
//
// 核心不变量（本文件的存在意义）：
//   · 鲸鱼图形只占窗口右下 59.45%，窗口必然比图形大；四条边要能贴到屏幕边，
//     就必须允许窗口把透明留白推出屏幕。
//   · 「图形矩形」必须始终按**当前**窗口尺寸推导。若把某个尺寸下的 px 快照冻结
//     复用（缩放过再拖就会这样），右/下会残留 (新窗口 - 旧窗口) 宽的死区，
//     表现为「拖不过去的空气墙」。
// ---------------------------------------------------------------------------

const ART_RATIO = 0.5945
// 图形上/左侧的透明留白比例（= 1 - ART_RATIO）
const HEAD_RATIO = 1 - ART_RATIO

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v)
}

function num(v, def) {
  const n = Number(v)
  return isFinite(n) ? n : def
}

// 缺省图形矩形：锚定窗口右下 ART_RATIO，上/左留 HEAD_RATIO
function defaultFishNorm() {
  return { x: HEAD_RATIO, y: HEAD_RATIO, w: ART_RATIO, h: ART_RATIO }
}

// 渲染进程上报的 fish（窗口内 CSS px）→ 归一化比例（0..1）
// 非法输入回退到默认比例；越界值夹进窗口内。
function fishNormOf(fish, box) {
  const W = Math.max(1, num(box && box.width, 1))
  const H = Math.max(1, num(box && box.height, 1))
  const f = fish && typeof fish === 'object' ? fish : null
  const ok = f && [f.x, f.y, f.w, f.h].every((v) => isFinite(Number(v))) && Number(f.w) > 0 && Number(f.h) > 0
  if (!ok) return defaultFishNorm()
  const x = clamp(num(f.x, 0), 0, W)
  const y = clamp(num(f.y, 0), 0, H)
  const w = Math.min(num(f.w, 0), W - x)
  const h = Math.min(num(f.h, 0), H - y)
  if (!(w > 0) || !(h > 0)) return defaultFishNorm()
  return { x: x / W, y: y / H, w: w / W, h: h / H }
}

// 归一化比例 → 当前窗口下的 px 矩形（夹在窗口内）
function fishFromNorm(norm, box) {
  const W = Math.max(1, num(box && box.width, 1))
  const H = Math.max(1, num(box && box.height, 1))
  const n = norm && typeof norm === 'object' ? norm : defaultFishNorm()
  const x = clamp(Math.round(num(n.x, HEAD_RATIO) * W), 0, W)
  const y = clamp(Math.round(num(n.y, HEAD_RATIO) * H), 0, H)
  return {
    x, y,
    w: Math.max(1, Math.min(Math.round(num(n.w, ART_RATIO) * W), W - x)),
    h: Math.max(1, Math.min(Math.round(num(n.h, ART_RATIO) * H), H - y)),
  }
}

// 窗口可停放范围：以「图形四条边贴屏幕边」为准。
//   bd = 显示器完整边界（左/上允许负坐标，把留白推出屏幕）
//   wa = 工作区（右/下不藏任务栏）
// 返回 { minX, maxX, minY, maxY }（窗口框坐标）。
function windowRange(fish, geom, bd, wa) {
  const f = fish && typeof fish === 'object' ? fish : { x: 0, y: 0, w: 1, h: 1 }
  const g = geom && typeof geom === 'object' ? geom : { insetX: 0, insetY: 0 }
  const insetX = num(g.insetX, 0)
  const insetY = num(g.insetY, 0)
  const d = bd && typeof bd === 'object' ? bd : { x: 0, y: 0, width: 1920, height: 1080 }
  const w = wa && typeof wa === 'object' ? wa : d
  const minX = num(d.x, 0) - (insetX + f.x)
  const maxX = Math.max(num(d.x, 0), num(d.x, 0) + num(d.width, 0) - (insetX + f.x + f.w))
  const minY = num(d.y, 0) - (insetY + f.y)
  const maxY = Math.max(num(w.y, 0), num(w.y, 0) + num(w.height, 0) - (insetY + f.y + f.h))
  return { minX, maxX, minY, maxY }
}

// 把窗口位置钳进可停放范围
function clampWindow(x, y, fish, geom, bd, wa) {
  const r = windowRange(fish, geom, bd, wa)
  return { x: Math.round(clamp(num(x, 0), r.minX, r.maxX)), y: Math.round(clamp(num(y, 0), r.minY, r.maxY)), range: r }
}

// 图形在屏幕上的四条边（用于验证「真能贴边」）
function fishScreenEdges(winX, winY, fish, geom) {
  const g = geom && typeof geom === 'object' ? geom : { insetX: 0, insetY: 0 }
  return {
    left: winX + num(g.insetX, 0) + fish.x,
    top: winY + num(g.insetY, 0) + fish.y,
    right: winX + num(g.insetX, 0) + fish.x + fish.w,
    bottom: winY + num(g.insetY, 0) + fish.y + fish.h,
  }
}

module.exports = {
  ART_RATIO, HEAD_RATIO,
  defaultFishNorm, fishNormOf, fishFromNorm, windowRange, clampWindow, fishScreenEdges,
}
