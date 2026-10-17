'use strict'
// ---------------------------------------------------------------------------
// v0.4.0 新功能单元测试（纯 Node，不依赖 Electron）
// 覆盖：自定义泡泡框（框库 / 安全区 / 镜像 / 上传删除）与音效四通道消毒
//
// 期望值来自上游 v0.4.0 的行为约定：
//   · 换框不改内容序列，只改「框 + 内容安全区」
//   · 安全区永远夹在画布内，镜像时整块翻转（尾巴换边）
//   · 音效通道默认只开「按压」，显式关闭/音量为 0 必须被尊重
// ---------------------------------------------------------------------------
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pet-v40-'))
process.env.WHALE_PET_HOME = TEST_HOME
delete process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_PLATFORM_TOKEN

const frame = require('../lib/frame')
const audio = require('../lib/audio')
const config = require('../lib/config')
const store = require('../lib/store')

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

console.log('v0.4.0 泡泡框 + 音效通道')

// ============================ 泡泡框：模型 ============================
test('frame: 空配置 → classic，无自定义框，无安全区覆盖', () => {
  const c = frame.sanitize(null)
  assert.strictEqual(c.sel, 'classic')
  assert.strictEqual(c.mirror, false)
  assert.strictEqual(c.safe, null)
  assert.deepStrictEqual(c.custom, [])
})

test('frame: 内置框共 5 个，id 稳定', () => {
  const ids = frame.list({}).map(function (f) { return f.id })
  assert.deepStrictEqual(ids, ['classic', 'round', 'note', 'dashed', 'glass'])
})

test('frame: 经典框安全区中心仍是 44.25% / 38%（老用户视觉零变化）', () => {
  const eff = frame.effective({})
  assert.strictEqual(eff.kind, 'classic')
  assert.strictEqual(Math.round((eff.safe.x + eff.safe.w / 2) * 10000) / 100, 44.25)
  assert.strictEqual(Math.round((eff.safe.y + eff.safe.h / 2) * 10000) / 100, 38)
})

test('frame: 安全区越界被夹回画布内（x+w ≤ 1、y+h ≤ 1）', () => {
  const s = frame.sanitizeSafe({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })
  assert.ok(s.x + s.w <= 1.0001, 'x+w 越界: ' + JSON.stringify(s))
  assert.ok(s.y + s.h <= 1.0001, 'y+h 越界: ' + JSON.stringify(s))
  assert.ok(s.w >= 0.2 && s.h >= 0.2)
})

test('frame: 非法 sel 回退 classic（不会把泡泡渲染成空白）', () => {
  const c = frame.sanitize({ sel: 'not-exist' })
  assert.strictEqual(c.sel, 'classic')
})

test('frame: 镜像时安全区水平翻转、尾巴换边', () => {
  const eff = frame.effective({ sel: 'glass', mirror: true })
  // glass 默认尾巴在右 → 镜像后在左
  assert.strictEqual(eff.tail, 'left')
  const base = frame.builtinDef('glass').safe
  assert.strictEqual(Math.round((eff.safe.x + eff.safe.w + base.x) * 10000) / 10000, 1)
  assert.strictEqual(eff.safe.y, base.y)
})

test('frame: 非法自定义框（坏 id / 重复 / 与内置同名）被丢弃', () => {
  const c = frame.sanitize({
    custom: [
      { id: 'frame_a', name: 'A', safe: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
      { id: 'frame_a', name: 'A2' },
      { id: 'bad id!', name: 'B' },
      { id: 'classic', name: 'C' },
    ],
  })
  assert.strictEqual(c.custom.length, 1)
  assert.strictEqual(c.custom[0].id, 'frame_a')
})

// ============================ 泡泡框：持久化 ============================
function pngDataUrl(size) {
  const buf = Buffer.alloc(size, 0)
  // 最小 PNG 头，保证内容看起来是图片（消毒只检查体积与 base64 形态）
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  return 'data:image/png;base64,' + buf.toString('base64')
}

test('frame store: 上传 → 自动选中 → 出现在框库', () => {
  const res = store.uploadFrame('我的框', pngDataUrl(128))
  assert.strictEqual(res.ok, true)
  assert.ok(res.id)
  assert.strictEqual(res.sel, res.id)
  const ids = res.frames.map(function (f) { return f.id })
  assert.ok(ids.indexOf(res.id) !== -1)
  const eff = res.effective
  assert.strictEqual(eff.kind, 'image')
  assert.strictEqual(eff.builtin, false)
})

test('frame store: 上传后能读回图片字节', () => {
  const res = store.uploadFrame('读回', pngDataUrl(128))
  const got = store.loadFrameImage(res.id)
  assert.ok(got && got.bytes.length >= 128)
  assert.strictEqual(got.mime, 'image/png')
})

test('frame store: 拒绝非图片 / 过小的数据', () => {
  assert.strictEqual(store.uploadFrame('x', 'data:text/plain;base64,AAAA').ok, false)
  assert.strictEqual(store.uploadFrame('x', 'data:image/png;base64,AAAA').ok, false)
})

test('frame store: 删除自定义框后回退 classic，且内置框不可删', () => {
  const up = store.uploadFrame('待删', pngDataUrl(128))
  const del = store.deleteFrame(up.id)
  assert.strictEqual(del.ok, true)
  assert.strictEqual(del.sel, 'classic')
  assert.strictEqual(del.frames.some(function (f) { return f.id === up.id }), false)
  assert.strictEqual(store.deleteFrame('classic').ok, false)
})

test('frame store: 保存镜像与安全区覆盖，载荷里能读到生效值', () => {
  const res = store.setFrame({ sel: 'round', mirror: true, safe: { x: 0.2, y: 0.2, w: 0.4, h: 0.3 } })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.sel, 'round')
  assert.strictEqual(res.mirror, true)
  // 覆盖 safe 后，镜像生效值 = 1 - x - w
  assert.strictEqual(Math.round(res.effective.safe.x * 100) / 100, 0.4)
  assert.strictEqual(res.effective.safe.w, 0.4)
  // 恢复默认（safe:null）后回到框自带安全区
  const back = store.setFrame({ safe: null })
  assert.strictEqual(back.safe, null)
  // 镜像仍开着：生效值应是 round 默认安全区翻转后的 x
  const base = frame.builtinDef('round').safe
  assert.strictEqual(back.effective.safe.x, Math.round((1 - base.x - base.w) * 10000) / 10000)
})

// ============================ 音效通道 ============================
test('audio: 四通道默认只有 press 开，其余全关', () => {
  const ch = audio.defaultChannels()
  assert.deepStrictEqual(Object.keys(ch), ['press', 'cost', 'ask', 'alert'])
  assert.strictEqual(ch.press.on, true)
  assert.strictEqual(ch.cost.on, false)
  assert.strictEqual(ch.ask.on, false)
  assert.strictEqual(ch.alert.on, false)
})

test('audio: 显式关闭 / 音量 0 被尊重，音量越界被钳制', () => {
  const ch = audio.sanitizeChannels({
    press: { on: false, vol: 0 },
    cost: { on: true, vol: 2 },
  })
  assert.strictEqual(ch.press.on, false)
  assert.strictEqual(ch.press.vol, 0)
  assert.strictEqual(ch.cost.on, true)
  assert.strictEqual(ch.cost.vol, 1)
})

test('audio: 非法片段引用回退到通道默认片段', () => {
  const ch = audio.sanitizeChannels({ cost: { on: true, frag: 'evil; rm -rf /' } })
  assert.strictEqual(ch.cost.frag, audio.AUDIO_CHANNEL_DEFAULTS.cost.frag)
  const ok = audio.sanitizeChannels({ ask: { frag: 'frag:end_a' } })
  assert.strictEqual(ok.ask.frag, 'frag:end_a')
})

test('config: 缺字段的旧配置会被补上 audioChannels 默认值', () => {
  const c = config.sanitize({ apiKey: 'sk-test' })
  assert.strictEqual(c.audioChannels.press.on, true)
  assert.strictEqual(c.audioChannels.cost.on, false)
  assert.strictEqual(c.apiKey, 'sk-test')
})

console.log('\n' + passed + ' v0.4.0 tests passed' + (failed ? '，' + failed + ' failed' : ''))
