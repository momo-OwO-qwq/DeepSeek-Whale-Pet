'use strict'
// ---------------------------------------------------------------------------
// 拖拽/定位几何回归测试（重点：修复「缩放后空气墙」）
//
// 背景：鲸鱼图形只占窗口右下 59.45%，窗口比图形大。四条边要能贴到屏幕边，
// 就必须允许窗口把透明留白推出屏幕。这套换算过去分散在 main.js 与
// renderer/pet.js 各写一遍，且把某个尺寸下的 px 快照冻结复用 —— 结果
// 「由大变小时」右侧/底部残留死区，拖不过去（空气墙）。
//
// 本文件锁定三条不变量：
//   A. 任意窗口尺寸下，图形四条边都能贴到屏幕对应边（无死区）
//   B. 图形矩形按**当前**窗口尺寸推导（缩放后不残留旧尺寸）
//   C. 图形不会被推出屏幕外（不会「贴过头」看不见）
// ---------------------------------------------------------------------------
const assert = require('assert')
const path = require('path')

const geo = require('../lib/geometry')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✔ ' + name)
  } catch (err) {
    failed++
    console.error('  ✘ ' + name)
    console.error('    ' + (err && err.message ? err.message : err))
    process.exitCode = 1
  }
}

const BASE_PX = 320
// 与 main.js 一致的显示器/工作区（任务栏 32px）
const BD = { x: 0, y: 0, width: 1920, height: 1080 }
const WA = { x: 0, y: 32, width: 1920, height: 1048 }
const GEOM = { insetX: 0, insetY: 0 } // 内容区 == 窗口框（Linux 常见）

function winSizeFor(scale) {
  const w = Math.round(BASE_PX * scale)
  return { width: w, height: w }
}

// 模拟渲染进程上报的 fish：图形锚定窗口右下 59.45%
function reportedFish(winSize) {
  const iw = Math.round(winSize.width * 0.5945)
  return { x: winSize.width - iw, y: winSize.height - iw, w: iw, h: iw }
}

test('geometry: 默认比例 = 图形占右下 59.45%（上/左留白 40.55%）', () => {
  const n = geo.defaultFishNorm()
  assert.strictEqual(n.w, geo.ART_RATIO)
  assert.strictEqual(n.x, geo.HEAD_RATIO)
  assert.ok(Math.abs(geo.ART_RATIO + geo.HEAD_RATIO - 1) < 1e-9)
})

test('geometry: fish 归一化往返一致（同尺寸）', () => {
  for (const scale of [0.6, 1.0, 1.5, 2.0, 2.5]) {
    const ws = winSizeFor(scale)
    const norm = geo.fishNormOf(reportedFish(ws), ws)
    const back = geo.fishFromNorm(norm, ws)
    const orig = reportedFish(ws)
    // 允许 1px 取整误差
    assert.ok(Math.abs(back.x - orig.x) <= 1, 'scale ' + scale + ' x')
    assert.ok(Math.abs(back.w - orig.w) <= 1, 'scale ' + scale + ' w')
  }
})

test('geometry: 非法/缺失 fish 回退默认比例，不抛异常', () => {
  const ws = { width: 320, height: 320 }
  for (const bad of [null, undefined, {}, { x: 1 }, { x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 }, 'nope']) {
    const n = geo.fishNormOf(bad, ws)
    assert.deepStrictEqual(n, geo.defaultFishNorm(), JSON.stringify(bad))
  }
})

test('geometry: fish 越界值被夹进窗口内', () => {
  const ws = { width: 320, height: 320 }
  const n = geo.fishNormOf({ x: 999, y: -50, w: 999, h: 999 }, ws)
  const px = geo.fishFromNorm(n, ws)
  assert.ok(px.x >= 0 && px.x <= 320)
  assert.ok(px.y >= 0 && px.y <= 320)
  assert.ok(px.x + px.w <= 320)
  assert.ok(px.y + px.h <= 320)
})

// ============================ 核心：无死区（空气墙） ============================
test('空气墙回归：任意缩放下，鲸鱼右边都能贴到屏幕右缘', () => {
  for (const scale of [0.6, 0.8, 1.0, 1.5, 2.0, 2.5]) {
    const ws = winSizeFor(scale)
    const fish = geo.fishFromNorm(geo.fishNormOf(reportedFish(ws), ws), ws)
    const r = geo.windowRange(fish, GEOM, BD, WA)
    const edges = geo.fishScreenEdges(r.maxX, 0, fish, GEOM)
    assert.strictEqual(edges.right, BD.x + BD.width, 'scale ' + scale + ' 右缘应贴 ' + (BD.x + BD.width))
  }
})

test('空气墙回归：任意缩放下，鲸鱼左边都能贴到屏幕左缘', () => {
  for (const scale of [0.6, 1.0, 2.0, 2.5]) {
    const ws = winSizeFor(scale)
    const fish = geo.fishFromNorm(geo.fishNormOf(reportedFish(ws), ws), ws)
    const r = geo.windowRange(fish, GEOM, BD, WA)
    const edges = geo.fishScreenEdges(r.minX, 0, fish, GEOM)
    assert.strictEqual(edges.left, BD.x, 'scale ' + scale + ' 左缘应贴 0')
  }
})

test('空气墙回归：鲸鱼下边贴工作区底（不藏任务栏）', () => {
  for (const scale of [0.6, 1.0, 2.0, 2.5]) {
    const ws = winSizeFor(scale)
    const fish = geo.fishFromNorm(geo.fishNormOf(reportedFish(ws), ws), ws)
    const r = geo.windowRange(fish, GEOM, BD, WA)
    const edges = geo.fishScreenEdges(0, r.maxY, fish, GEOM)
    assert.strictEqual(edges.bottom, WA.y + WA.height, 'scale ' + scale + ' 底边应贴工作区底')
  }
})

// ============================ 修复的核心：缩放不残留旧尺寸 ============================
test('空气墙根因：缩小后用【旧尺寸】fish 会留下死区（证明必须按当前尺寸重算）', () => {
  const big = winSizeFor(2.0)   // 640
  const small = winSizeFor(1.0) // 320
  const fishBig = geo.fishFromNorm(geo.fishNormOf(reportedFish(big), big), big)
  const fishSmall = geo.fishFromNorm(geo.fishNormOf(reportedFish(small), small), small)

  // 用旧（大）fish 钳制，窗口右边到不了屏幕右缘
  const rStale = geo.windowRange(fishBig, GEOM, BD, WA)
  const staleRight = (rStale.maxX + small.width)
  assert.ok(staleRight < BD.x + BD.width,
    '旧 fish 应留下死区（这正是 bug 现象）')
  const dead = (BD.x + BD.width) - staleRight
  assert.strictEqual(dead, big.width - small.width, '死区宽度应等于窗口尺寸差')

  // 用当前（小）fish 钳制，精确贴到右缘，无死区
  const rFresh = geo.windowRange(fishSmall, GEOM, BD, WA)
  assert.strictEqual(rFresh.maxX + small.width, BD.x + BD.width, '当前 fish 应精确贴边')
})

test('空气墙修复：归一化 fish 在缩放后仍能精确贴边（比例不随尺寸失效）', () => {
  // 用户在 2.0 尺寸下开始拖拽 → fish 归一化保存 → 途中缩小到 1.0
  const big = winSizeFor(2.0)
  const norm = geo.fishNormOf(reportedFish(big), big) // drag:start 时保存
  const small = winSizeFor(1.0)
  // 钳制时按**当前**窗口还原（这正是 main.js currentDragGeom 做的事）
  const fishNow = geo.fishFromNorm(norm, small)
  const r = geo.windowRange(fishNow, GEOM, BD, WA)
  const edges = geo.fishScreenEdges(r.maxX, r.maxY, fishNow, GEOM)
  assert.strictEqual(edges.right, BD.x + BD.width, '缩放后仍能贴右缘')
  assert.strictEqual(edges.bottom, WA.y + WA.height, '缩放后仍能贴底边')
})

test('空气墙修复：放大后同样无死区（对称性）', () => {
  const small = winSizeFor(1.0)
  const norm = geo.fishNormOf(reportedFish(small), small)
  const big = winSizeFor(2.0)
  const fishNow = geo.fishFromNorm(norm, big)
  const r = geo.windowRange(fishNow, GEOM, BD, WA)
  assert.strictEqual(r.maxX + big.width, BD.x + BD.width)
  assert.strictEqual(r.maxY + big.height, WA.y + WA.height)
})

test('连续多次缩放（2.5→0.6→1.8）后仍精确贴边', () => {
  let norm = null
  for (const scale of [2.5, 0.6, 1.8]) {
    const ws = winSizeFor(scale)
    if (norm === null) norm = geo.fishNormOf(reportedFish(ws), ws)
    const fish = geo.fishFromNorm(norm, ws)
    const r = geo.windowRange(fish, GEOM, BD, WA)
    assert.strictEqual(r.maxX + ws.width, BD.x + BD.width, 'scale ' + scale + ' 右缘')
    assert.strictEqual(r.maxY + ws.height, WA.y + WA.height, 'scale ' + scale + ' 底边')
  }
})

// ============================ 钳制边界行为 ============================
test('clampWindow: 夹住越界请求并返回 range', () => {
  const ws = winSizeFor(1.0)
  const fish = geo.fishFromNorm(geo.defaultFishNorm(), ws)
  const far = geo.clampWindow(99999, 99999, fish, GEOM, BD, WA)
  assert.strictEqual(far.x, far.range.maxX)
  assert.strictEqual(far.y, far.range.maxY)
  const neg = geo.clampWindow(-99999, -99999, fish, GEOM, BD, WA)
  assert.strictEqual(neg.x, neg.range.minX)
  assert.strictEqual(neg.y, neg.range.minY)
})

test('clampWindow: 范围内坐标不被改动', () => {
  const ws = winSizeFor(1.0)
  const fish = geo.fishFromNorm(geo.defaultFishNorm(), ws)
  const mid = geo.clampWindow(500, 300, fish, GEOM, BD, WA)
  assert.strictEqual(mid.x, 500)
  assert.strictEqual(mid.y, 300)
})

test('clampWindow: 左/上允许负坐标（把留白推出屏幕，鲸鱼本体才贴得到边）', () => {
  const ws = winSizeFor(1.0)
  const fish = geo.fishFromNorm(geo.defaultFishNorm(), ws)
  const r = geo.windowRange(fish, GEOM, BD, WA)
  assert.ok(r.minX < 0, '左边界应为负（留白推出屏幕）')
  assert.ok(r.minY < 0, '上边界应为负')
})

test('内容区 inset 被计入（窗口框 ≠ 内容区时仍贴边）', () => {
  const ws = winSizeFor(1.0)
  const fish = geo.fishFromNorm(geo.defaultFishNorm(), ws)
  const inset = { insetX: 8, insetY: 30 }
  const r = geo.windowRange(fish, inset, BD, WA)
  const edges = geo.fishScreenEdges(r.maxX, r.maxY, fish, inset)
  assert.strictEqual(edges.right, BD.x + BD.width)
  assert.strictEqual(edges.bottom, WA.y + WA.height)
})

test('极窄工作区不产生非法区间（min > max）', () => {
  const tinyWA = { x: 0, y: 0, width: 50, height: 50 }
  const ws = winSizeFor(2.5)
  const fish = geo.fishFromNorm(geo.defaultFishNorm(), ws)
  const r = geo.windowRange(fish, GEOM, BD, tinyWA)
  assert.ok(r.maxY >= r.minY, 'maxY 不应小于 minY')
  assert.ok(r.maxX >= r.minX, 'maxX 不应小于 minX')
})

// ============================ 与渲染层保持一致 ============================
test('一致性：main.js 已改为使用 lib/geometry.js（不再内联钳制公式）', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/require\('\.\/lib\/geometry'\)/.test(src), 'main.js 应引用 lib/geometry.js')
  assert.ok(/geometry\.clampWindow/.test(src), 'main.js 应调用 geometry.clampWindow')
  // 旧的内联公式不应再出现
  assert.ok(!/bd\.x - \(g\.insetX \+ f\.x\)/.test(src), '不应残留内联钳制公式')
  assert.ok(!/d\.bounds\.x - \(g\.insetX \+ f\.x\)/.test(src), '不应残留内联钳制公式')
})

test('一致性：fish 以归一化比例保存（而非 px 快照）', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/fishNorm:/.test(src), 'dragState 应保存 fishNorm')
  assert.ok(!/fish: fishRectOf\(/.test(src), '不应再保存 px 快照 fish')
  assert.ok(/currentDragGeom/.test(src), '应通过 currentDragGeom 取当前几何')
})

test('一致性：window:resize 等待真实尺寸生效后再返回', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/waitForSize/.test(src), 'window:resize 应等待尺寸落地')
  assert.ok(/settled/.test(src), '返回结果应带 settled 标记')
})

test('一致性：setScale 在改尺寸后等待布局帧再钳制', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('async function setScale')
  assert.ok(i !== -1, 'pet.js 应有 setScale')
  const body = src.slice(i, i + 3000)
  assert.ok(/nextFrame\(\)/.test(body), 'setScale 应等待布局帧（避免用旧布局算钳制）')
  // 等待必须发生在钳制之前
  const waitAt = body.indexOf('nextFrame()')
  const settleAt = body.indexOf('settlePos(')
  assert.ok(waitAt !== -1 && settleAt !== -1 && waitAt < settleAt, '等待应在 settlePos 之前')
})

test('一致性：几何常量与 CSS 的 .wp-img 尺寸一致（59.45%）', () => {
  const fs = require('fs')
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8')
  assert.ok(/width:\s*59\.45%/.test(css), 'CSS 中 .wp-img 宽应为 59.45%')
  assert.strictEqual(geo.ART_RATIO, 0.5945, 'geometry.ART_RATIO 应与 CSS 一致')
})


// ============================ 窗口裁剪（按用户要求已移除） ============================
// 曾用 win.setShape() 把窗口裁成「鲸鱼/气泡/按钮」区域。三个实际问题：
//   1) 气泡被一起裁掉（展开时超出鲸鱼矩形就被切边）
//   2) 早期 {x,y,w,h} 键名不合法 → setShape 每次都静默失败
//   3) 缩放后若 shape 未跟上，右下角不在裁剪区内 → 点不到、拖不动
// 现已整体移除：窗口保持完整矩形，交互稳定。
test('窗口裁剪回归：main.js 不再调用 setShape', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/\.setShape\s*\(/.test(code), 'main.js 不应再调用 setShape（用户要求不要裁剪）')
  assert.ok(!/function sanitizeRects/.test(code), 'sanitizeRects 已无使用者，应删除')
})

test('窗口裁剪回归：渲染层 reportShape 为空实现（调用点保留但不做事）', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('function reportShape')
  assert.ok(i !== -1, '应保留 reportShape 以免散落调用点报错')
  const body = src.slice(i, i + 60)
  assert.ok(/function reportShape\(\) \{\}/.test(body), 'reportShape 应为空实现')
  // 调用点仍应存在（不改动其它流程）
  const calls = (src.match(/reportShape\(\)/g) || []).length
  assert.ok(calls > 3, 'reportShape 调用点应保留，实得 ' + calls)
})

test('窗口裁剪回归：气泡不被裁剪（不再上报 shape）', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/api\.setShape\s*\(/.test(code), 'pet.js 不应再调用 api.setShape')
})

// ============================ 点击健壮性回归 ============================
test('点击回归：dragEnd 失败不吞掉气泡', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('async function onDocPointerUp')
  assert.ok(i !== -1, 'pet.js 应有 onDocPointerUp')
  const body = src.slice(i, i + 900)
  const clickBranch = body.indexOf('!drag.moved')
  assert.ok(clickBranch !== -1, '应有点击分支')
  // 先整段去注释，再取「点击分支 → onWhaleTap()」之间的真实代码
  const branch = body.slice(clickBranch, clickBranch + 400)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const tapAt = branch.indexOf('onWhaleTap()')
  assert.ok(tapAt !== -1, '点击分支应调用 onWhaleTap')
  const beforeTap = branch.slice(0, tapAt)
  assert.ok(!/await\s+api\.dragEnd\(\)/.test(beforeTap),
    '点击分支里 onWhaleTap 之前不应 await dragEnd（失败会吞掉气泡）')
  assert.ok(/api\.dragEnd\(\)\.catch/.test(beforeTap), 'dragEnd 应挂 catch 不阻塞')
})

test('气泡回归：startRound 必须置 bubbleShown（否则永远停在第 1 项）', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('function startRound')
  assert.ok(i !== -1, 'pet.js 应有 startRound')
  const body = src.slice(i, i + 900)
  assert.ok(/bubbleShown = true/.test(body), 'startRound 渲染自定义泡时必须置 bubbleShown=true')
})

test('气泡回归：hideBubble 重置轮次状态并清掉模块 DOM', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('function hideBubble')
  const body = src.slice(i, i + 1200)
  assert.ok(/bubbleRoundOn = false/.test(body), '收起应结束本轮')
  assert.ok(/bubbleSeqIdx = 0/.test(body), '收起应重置序号')
  assert.ok(/clearMods\(\)/.test(body), '收起应清掉自定义模块 DOM')
})

test('气泡回归：气泡展开时的点击要推进序列（不被吞掉）', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('function onDocPointerDown')
  const body = src.slice(i, i + 500)
  // 不应在 pointerdown 阶段无条件吞掉 .wp-bubble 上的点击
  assert.ok(!/closest\('\.wp-bubble'\)\) return/.test(body),
    'pointerdown 不应整体吞掉 wp-bubble 点击（会与 bubble click 处理竞争，导致第二下无反应）')
})

test('气泡回归：气泡自身的 click 在自定义序列下推进而非切随机台词', () => {
  const fs = require('fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf("bubbleBox.addEventListener('click'")
  const body = src.slice(i, i + 800)
  assert.ok(/customBubble/.test(body) && /bubbleNext\(\)/.test(body),
    '气泡点击应在有自定义配置时调用 bubbleNext')
})

if (failed) {
  console.error('\n' + passed + ' passed, ' + failed + ' FAILED')
  process.exitCode = 1
} else {
  console.log('\n' + passed + ' geometry tests passed')
}
