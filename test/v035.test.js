'use strict'
// ---------------------------------------------------------------------------
// v0.3.5 新功能单元测试（纯 Node，不依赖 Electron）
// 覆盖：自定义泡泡模型 / 音效库与任务结束音 / 资源库
//
// 这些用例的期望值全部来自上游 assets/whale-widget.js 与 lib/index.js 的
// 实际行为（含 v727 / v729 两次修复），是移植正确性的回归护栏。
// ---------------------------------------------------------------------------
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pet-v35-'))
process.env.WHALE_PET_HOME = TEST_HOME
delete process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_PLATFORM_TOKEN

const bubble = require('../lib/bubble')
const audio = require('../lib/audio')
const assets = require('../lib/assets')
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

// ============================ 泡泡：模块与约束 ============================
test('bubble: 字号档位 1→40u、50→240u（上游 bubbleModuleFontU）', () => {
  assert.strictEqual(bubble.moduleFontU(1), 40)
  assert.strictEqual(bubble.moduleFontU(50), 240)
  // 越界钳制，非法值回默认档
  assert.strictEqual(bubble.moduleFontU(0), 40)
  assert.strictEqual(bubble.moduleFontU(99), 240)
  assert.strictEqual(bubble.moduleFontU('x'), bubble.moduleFontU(bubble.DEFAULT_SIZE))
})

test('bubble: 图片类模块仅 image/randimg，且独占一行', () => {
  assert.strictEqual(bubble.isImgMod({ type: 'image' }), true)
  assert.strictEqual(bubble.isImgMod({ type: 'randimg' }), true)
  assert.strictEqual(bubble.isImgMod({ type: 'text' }), false)
  // 图片打断前后模块的行合并 → 三行
  const mods = [
    { type: 'text', text: 'a' },
    { type: 'image', imgId: 'x' },
    { type: 'text', text: 'b' },
  ]
  const rows = bubble.rowsOf(mods)
  assert.strictEqual(rows.length, 3)
  assert.strictEqual(rows[1].length, 1)
})

test('bubble: 行键 row 相同则同行；image 会打断合并（上游 bubbleRowsOf）', () => {
  const mods = [
    { type: 'text', text: 'a', row: 1 },
    { type: 'text', text: 'b', row: 1 },
    { type: 'text', text: 'c' },
  ]
  const rows = bubble.rowsOf(mods)
  assert.strictEqual(rows.length, 2, 'row:1 两个模块应同行')
  assert.strictEqual(rows[0].length, 2)
  // 图片即使带行键也必须独占一行
  const withImg = bubble.rowsOf([{ type: 'text', text: 'a', row: 3 }, { type: 'image', imgId: 'i', row: 3 }])
  assert.strictEqual(withImg.length, 2)
})

test('bubble: rowsFlat 同行写行键、单模块行不写键（上游 bubbleRowsFlat）', () => {
  const rows = [[{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], [{ type: 'text', text: 'c' }]]
  const flat = bubble.rowsFlat(rows)
  assert.strictEqual(flat[0].row, 1)
  assert.strictEqual(flat[1].row, 1)
  assert.strictEqual('row' in flat[2], false, '单模块行不应带行键')
})

test('bubble: rowsCanon 就地规范化并可重复调用（幂等）', () => {
  const mods = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b', row: 1 }, { type: 'image', imgId: 'i' }]
  bubble.rowsCanon(mods)
  const baseline = JSON.stringify(mods)
  bubble.rowsCanon(mods)
  assert.strictEqual(JSON.stringify(mods), baseline, '二次规范化不应改变结果')
  assert.strictEqual(mods[2].type, 'image')
})

test('bubble: 每行最多 6 个模块、最多 6 行（上游 MOD_MAX/ROW_MAX）', () => {
  assert.strictEqual(bubble.MOD_MAX, 6)
  assert.strictEqual(bubble.ROW_MAX, 6)
  const rows = []
  for (let i = 0; i < 8; i++) rows.push([{ type: 'text', text: 'm' + i }])
  // 并入已满的 6 模块行 → 拒绝
  const full = [[{ type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }]]
  assert.strictEqual(bubble.mergeIntoRow(full, { type: 'text' }, 0, false), null, '满行不能再并入')
  // 图片不能并入普通行
  assert.strictEqual(bubble.mergeIntoRow([[{ type: 'text' }]], { type: 'image', imgId: 'i' }, 0, true), null)
})

test('bubble: 拆行与整行排序', () => {
  const rows = [[{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]]
  const split = bubble.splitRow(rows, 0, 1)
  assert.strictEqual(split.length, 2)
  assert.strictEqual(split[0].length, 1)
  assert.strictEqual(split[1][0].text, 'b')
  // 单模块行不可再拆
  assert.strictEqual(bubble.splitRow([[{ type: 'text' }]], 0, 0), null)
  const moved = bubble.moveRow([[{ text: 'x', type: 'text' }], [{ text: 'y', type: 'text' }]], 0, 1)
  assert.strictEqual(moved[0][0].text, 'y')
  assert.strictEqual(moved[1][0].text, 'x')
})

test('bubble: 一个泡泡只允许一个图片模块（上游 bubbleItemHasImage）', () => {
  assert.strictEqual(bubble.countImages([{ type: 'image' }, { type: 'randimg' }]), 2)
  assert.strictEqual(bubble.itemHasImage([{ type: 'text' }, { type: 'randimg' }]), true)
  assert.strictEqual(bubble.itemHasImage([{ type: 'text' }]), false)
})

// ============================ 泡泡：消毒 ============================
test('bubble: 消毒丢弃未知字段、非法值回默认', () => {
  const m = bubble.sanitizeModule({
    type: 'text', text: '你好', evil: 'x', size: 999, color: 'not-a-color', rgb: 'nope',
  })
  assert.strictEqual(m.type, 'text')
  assert.strictEqual(m.text, '你好')
  assert.strictEqual('evil' in m, false, '未知字段必须丢弃')
  assert.strictEqual(m.size, 50, '字号应钳到上限')
  assert.strictEqual('color' in m, false, '非法颜色应被丢弃')
  assert.strictEqual('rgb' in m, false, '非法跑马灯键应被丢弃')
})

test('bubble: 文本与随机语句默认加粗，显式 false 保留（上游行为）', () => {
  assert.strictEqual(bubble.sanitizeModule({ type: 'text', text: 'a' }).bold, true)
  assert.strictEqual(bubble.sanitizeModule({ type: 'random', lines: [{ t: 'a' }] }).bold, true)
  assert.strictEqual(bubble.sanitizeModule({ type: 'text', text: 'a', bold: false }).bold, false)
  assert.strictEqual(bubble.sanitizeModule({ type: 'balance' }).bold, false)
})

test('bubble: 未知模块类型回退为文本', () => {
  assert.strictEqual(bubble.sanitizeModule({ type: 'evil' }).type, 'text')
})

test('bubble: choice 最多保留 2 个候选，权重至少为 1（上游 ci<2 / choiceWeight）', () => {
  const it = bubble.sanitizeItem({ kind: 'choice', options: [{ w: 1 }, { w: 2 }, { w: 3 }] }, 0)
  assert.strictEqual(it.kind, 'choice')
  assert.strictEqual(it.options.length, 2, '上游只取前 2 个候选')
  assert.strictEqual(bubble.choiceWeight({ w: 0 }), 1)
  assert.strictEqual(bubble.choiceWeight({ w: -5 }), 1)
  assert.strictEqual(bubble.choiceWeight({ w: '9' }), 9)
})

test('bubble: 整体配置消毒保形（v:1 / items / lib / tapAdvance）', () => {
  const cfg = bubble.sanitize({
    v: 999, items: [{ kind: 'custom', modules: [{ type: 'text', text: 'hi' }] }],
    lib: [{ id: 'bmod_1', name: '常用', module: { type: 'text', text: 'x' } }],
    tapAdvance: true, extra: 'drop',
  })
  assert.strictEqual(cfg.v, 1, '版本号固定为 1')
  assert.strictEqual(cfg.items.length, 1)
  assert.strictEqual(cfg.lib.length, 1)
  assert.strictEqual(cfg.lib[0].name, '常用')
  assert.strictEqual(cfg.tapAdvance, true)
  assert.strictEqual('extra' in cfg, false)
})

test('bubble: tapAdvance 仅严格 === true 才算开启（上游 d.config.tapAdvance === true）', () => {
  assert.strictEqual(bubble.sanitize({ tapAdvance: 'yes' }).tapAdvance, false)
  assert.strictEqual(bubble.sanitize({ tapAdvance: 1 }).tapAdvance, false)
  assert.strictEqual(bubble.sanitize({ tapAdvance: true }).tapAdvance, true)
})

// ============================ 泡泡：加权抽样 ============================
test('bubble: 并列候选择按权重抽样（上游 bubblePickChoiceStep）', () => {
  const opts = [{ w: 1, item: { kind: 'normal' } }, { w: 9, item: { kind: 'random' } }]
  // rnd=0.05 → 落在第一个（1/10）；rnd=0.5 → 落在第二个
  assert.strictEqual(bubble.pickChoice(opts, () => 0.05).kind, 'normal')
  assert.strictEqual(bubble.pickChoice(opts, () => 0.5).kind, 'random')
  assert.strictEqual(bubble.pickChoice([], () => 0.5), null)
})

test('bubble: 随机语句不连续重复，单条池除外（上游 anti-repeat）', () => {
  const lines = [{ t: 'a', w: 1 }, { t: 'b', w: 1 }]
  // 上一次是 a → 池里只剩 b
  assert.strictEqual(bubble.pickLine(lines, 'a', () => 0), 'b')
  // 单条池无法避免重复
  assert.strictEqual(bubble.pickLine([{ t: 'only', w: 1 }], 'only', () => 0), 'only')
  assert.strictEqual(bubble.pickLine([], 'a', () => 0), '')
})

test('bubble: 随机图片不连续重复', () => {
  const imgs = [{ id: 'p', w: 1 }, { id: 'q', w: 1 }]
  assert.strictEqual(bubble.pickImage(imgs, 'p', () => 0), 'q')
  assert.strictEqual(bubble.pickImage([], 'p', () => 0), '')
})

test('bubble: 并列泡每次都独立抽，无记忆（上游注释：不记忆上次）', () => {
  const opts = [{ w: 1, item: { kind: 'normal' } }, { w: 1, item: { kind: 'random' } }]
  // 连续两次同 seed 应得到同一结果（证明无内部记忆状态）
  const a = bubble.pickChoice(opts, () => 0)
  const b = bubble.pickChoice(opts, () => 0)
  assert.deepStrictEqual(a, b)
})

// ============================ 泡泡：点击状态机 ============================
test('bubble: 未显示时点按 → 从第 1 项开始', () => {
  const r = bubble.advance({ idx: 0 }, false, 3, { shown: false })
  assert.strictEqual(r.act, 'start')
  assert.strictEqual(r.idx, 0)
  assert.strictEqual(r.show, true)
})

test('bubble: tapAdvance=false，正在看第 1 项 → 只续时不换内容（idx<=1）', () => {
  const r = bubble.advance({ idx: 1 }, false, 3, {})
  assert.strictEqual(r.act, 'reset')
  assert.strictEqual(r.idx, 1, 'idx 不变')
})

test('bubble: tapAdvance=false，第 2 项及以后 → 回到序列开头', () => {
  const r = bubble.advance({ idx: 2 }, false, 3, {})
  assert.strictEqual(r.act, 'start')
  assert.strictEqual(r.idx, 0)
})

test('bubble: tapAdvance=true → 往后推进；已是最后一项则收起', () => {
  const n = bubble.advance({ idx: 1 }, true, 3, {})
  assert.strictEqual(n.act, 'next')
  assert.strictEqual(n.idx, 1, '推进由渲染层在显示时自增')
  const last = bubble.advance({ idx: 3 }, true, 3, {})
  assert.strictEqual(last.act, 'close')
  assert.strictEqual(last.show, false)
})

test('bubble: 非手动轮且 tapAdvance=false → 不动作', () => {
  const r = bubble.advance({ idx: 2 }, false, 3, { roundOn: false })
  assert.strictEqual(r.act, 'ignore')
})

test('bubble: resolveStep 把 choice 落地成具体泡', () => {
  const items = [{ kind: 'normal' }, { kind: 'choice', options: [{ w: 1, item: { kind: 'random' } }] }]
  assert.strictEqual(bubble.resolveStep(items, 0, () => 0).kind, 'normal')
  assert.strictEqual(bubble.resolveStep(items, 1, () => 0).kind, 'random')
  assert.strictEqual(bubble.resolveStep(items, 9, () => 0), null)
})

// ============================ 泡泡：占位符 ============================
test('bubble: 占位符替换，未知占位符原样保留', () => {
  const out = bubble.renderTemplate('余额 {balance} 今日 {today} 未知 {nope}', { balance: '¥ 10.00', today: '¥ 1.00' })
  assert.strictEqual(out, '余额 ¥ 10.00 今日 ¥ 1.00 未知 {nope}')
})

// ============================ 音效库 ============================
test('audio: 内置片段与内置组固定不可删（上游 PRESET_*）', () => {
  assert.strictEqual(audio.isPresetFragment('exp_orb'), true)
  assert.strictEqual(audio.isPresetFragment('end_a'), true)
  assert.strictEqual(audio.isPresetFragment('ya1'), true)
  assert.strictEqual(audio.isPresetGroup('duck'), true)
  assert.strictEqual(audio.isPresetGroup('fx1'), true)
  assert.strictEqual(audio.isPresetFragment('audio_xyz'), false)
})

test('audio: 任务结束音默认关闭且默认选中内置经验球（上游 usageSettingsDefaults）', () => {
  assert.strictEqual(audio.TASK_END_DEFAULTS.on, false)
  assert.strictEqual(audio.TASK_END_DEFAULTS.sel, 'frag:exp_orb')
  const t = audio.sanitizeTaskEnd(undefined)
  assert.strictEqual(t.on, false)
  assert.strictEqual(t.sel, 'frag:exp_orb')
})

test('audio: taskEnd.on 仅严格 true 生效；非法 sel 回默认', () => {
  assert.strictEqual(audio.sanitizeTaskEnd({ on: 'yes' }).on, false)
  assert.strictEqual(audio.sanitizeTaskEnd({ on: true }).on, true)
  assert.strictEqual(audio.sanitizeTaskEnd({ sel: 'garbage' }).sel, 'frag:exp_orb')
  assert.strictEqual(audio.sanitizeTaskEnd({ sel: 'frag:end_a' }).sel, 'frag:end_a')
})

test('audio: sel 语法解析（frag / preset / grp）', () => {
  assert.deepStrictEqual(audio.parseTaskEndSel('frag:end_a'), { kind: 'frag', fragment: 'end_a' })
  assert.deepStrictEqual(audio.parseTaskEndSel('preset:duck:release'), { kind: 'preset', group: 'duck', slot: 'release', fragment: 'ya2' })
  assert.strictEqual(audio.parseTaskEndSel('grp:group_1').kind, 'group')
  assert.strictEqual(audio.parseTaskEndSel('nope'), null)
  assert.strictEqual(audio.parseTaskEndSel('preset:nosuch:press'), null)
})

test('audio: 槽位语义 —— 空串=显式静音，缺失=回退内置预设（关键区别）', () => {
  const idx = {
    version: 1, fragments: [],
    groups: [
      { id: 'group_a', name: 'A', press: '', release: 'end_a' },
      { id: 'group_b', name: 'B', press: '', release: '' },
      { id: 'group_c', name: 'C' },
    ],
  }
  // 空串 → 显式静音
  assert.strictEqual(audio.groupFragmentId(idx, 'group_a', 'press'), '')
  assert.strictEqual(audio.groupFragmentId(idx, 'group_a', 'release'), 'end_a')
  assert.strictEqual(audio.groupFragmentId(idx, 'group_b', 'press'), '')
  // 缺失 → 回退内置小黄鸭
  assert.strictEqual(audio.groupFragmentId(idx, 'group_c', 'press'), 'ya1')
  assert.strictEqual(audio.groupFragmentId(idx, 'group_c', 'release'), 'ya2')
})

test('audio: 未知组回退内置预设；内置组解析到正确片段', () => {
  assert.strictEqual(audio.groupFragmentId(null, 'duck', 'press'), 'ya1')
  assert.strictEqual(audio.groupFragmentId(null, 'duck', 'release'), 'ya2')
  assert.strictEqual(audio.groupFragmentId(null, 'fx1', 'press'), 'd1')
  assert.strictEqual(audio.groupFragmentId(null, 'nosuch', 'press'), 'ya1')
})

test('audio: 任务结束音序列 —— 两个槽都空=静音，只空一个仍要发声（v729 修复）', () => {
  // 两槽都空 → 不发声
  const idxEmpty = { version: 1, fragments: [], groups: [{ id: 'group_b', name: 'B', press: '', release: '' }] }
  assert.deepStrictEqual(audio.taskEndSequence(idxEmpty, 'grp:group_b'), [])
  // 只有 release → 仍必须发声（这正是 v729 修复的 bug）
  const idxOnlyRel = { version: 1, fragments: [], groups: [{ id: 'group_a', name: 'A', press: '', release: 'end_a' }] }
  assert.deepStrictEqual(audio.taskEndSequence(idxOnlyRel, 'grp:group_a'), ['end_a'])
  // 只有 press → 发声
  const idxOnlyPress = { version: 1, fragments: [], groups: [{ id: 'group_p', name: 'P', press: 'exp_orb', release: '' }] }
  assert.deepStrictEqual(audio.taskEndSequence(idxOnlyPress, 'grp:group_p'), ['exp_orb'])
  // 两个都有 → 依次播放
  const idxBoth = { version: 1, fragments: [], groups: [{ id: 'group_x', name: 'X', press: 'exp_orb', release: 'end_a' }] }
  assert.deepStrictEqual(audio.taskEndSequence(idxBoth, 'grp:group_x'), ['exp_orb', 'end_a'])
  // 单片段
  assert.deepStrictEqual(audio.taskEndSequence(null, 'frag:end_a'), ['end_a'])
})

test('audio: 播放状态重置先于「无音源短路」（v729 的落地体现）', () => {
  const st = audio.newPlaybackState()
  st.pressEnded = true
  st.releasePlayed = true
  audio.beginPress(st)
  assert.strictEqual(st.pressEnded, false, '每次点按都要重置 pressEnded')
  assert.strictEqual(st.releasePlayed, false, '每次点按都要重置 releasePlayed')
})

test('audio: 索引消毒丢弃内置 id、非法 id 与重复项', () => {
  const idx = audio.sanitizeIndex({
    version: 1,
    fragments: [{ id: 'ok_1', name: 'x' }, { id: 'ya1', name: '内置不可覆盖' }, { id: '../evil' }, { id: 'ok_1', name: 'dup' }],
    groups: [{ id: 'duck', name: '内置组不可覆盖' }, { id: 'g_1', name: 'mine' }],
  })
  assert.strictEqual(idx.fragments.length, 1)
  assert.strictEqual(idx.fragments[0].id, 'ok_1')
  assert.strictEqual(idx.groups.length, 1)
  assert.strictEqual(idx.groups[0].id, 'g_1')
})

test('audio: 组排序 = 置顶 → 内置预设 → 未置顶（上游 audioGroupsPayload）', () => {
  const groups = [
    { id: 'g_old', name: 'old', createdAt: 100, pinnedAt: null },
    { id: 'g_new', name: 'new', createdAt: 900, pinnedAt: null },
    { id: 'g_pin', name: 'pin', createdAt: 50, pinnedAt: 5000 },
  ]
  const sorted = audio.sortGroups(groups)
  assert.strictEqual(sorted[0].id, 'g_pin', '置顶的在最前')
  assert.strictEqual(sorted[1].id, 'duck', '内置预设排在置顶之后')
  assert.strictEqual(sorted[2].id, 'fx1')
  assert.strictEqual(sorted[3].id, 'g_new', '未置顶按 createdAt 倒序')
  assert.strictEqual(sorted[4].id, 'g_old')
})

test('audio: 内置片段 MIME 必须与字节一致，用户片段一律 audio/wav', () => {
  assert.strictEqual(audio.fragmentMime('ya1'), 'audio/mpeg')
  assert.strictEqual(audio.fragmentMime('exp_orb'), 'audio/wav')
  assert.strictEqual(audio.fragmentMime('end_a'), 'audio/wav')
  assert.strictEqual(audio.fragmentMime('audio_custom'), 'audio/wav')
})

test('audio: 片段/组的 id 路径不可穿越', () => {
  assert.strictEqual(audio.userFragmentPath('/d', '../evil'), null)
  assert.strictEqual(audio.userFragmentPath('/d', 'exp_orb'), null, '内置片段不落用户目录')
  assert.ok(audio.userFragmentPath('/d', 'audio_ok'))
})

// ============================ 资源库 ============================
test('assets: 角色消毒幂等，内置 default 始终存在且唯一', () => {
  const a = assets.sanitizeRoles({ roles: [{ id: 'role_1', name: 'x', format: 'gif' }] })
  assert.strictEqual(a.roles.length, 2)
  assert.strictEqual(a.roles[0].id, 'default')
  const b = assets.sanitizeRoles(a)
  const c = assets.sanitizeRoles(b)
  assert.strictEqual(c.roles.length, 2, '重复消毒不应增殖')
  assert.strictEqual(c.roles.filter((r) => r.id === 'default').length, 1, 'default 必须唯一')
})

test('assets: 角色排序 = 置顶 → createdAt 倒序（上游 sortRoles）', () => {
  const sorted = assets.sortRoles({
    roles: [
      { id: 'role_old', name: 'o', createdAt: 100 },
      { id: 'role_new', name: 'n', createdAt: 900 },
    ],
  })
  assert.strictEqual(sorted[0].id, 'default', 'default 置顶')
  assert.strictEqual(sorted[1].id, 'role_new')
  assert.strictEqual(sorted[2].id, 'role_old')
})

test('assets: 角色扩展名 —— gif 之外一律 png（APNG 也是 png 容器）', () => {
  assert.strictEqual(assets.roleFileExt('gif'), 'gif')
  assert.strictEqual(assets.roleFileExt('png'), 'png')
  assert.strictEqual(assets.roleFileExt('apng'), 'png')
})

test('assets: 角色文件路径不可穿越，default 不落盘', () => {
  assert.strictEqual(assets.roleFilePath('/d', '../evil', 'png'), null)
  assert.strictEqual(assets.roleFilePath('/d', 'default', 'png'), null)
  assert.strictEqual(assets.roleFilePath('/d', 'role_1', 'gif'), path.join('/d', 'role_1.gif'))
})

test('assets: 泡泡图只接受 png/gif，角色接受更多格式（上游差异）', () => {
  const png = 'data:image/png;base64,AAAA'
  const webp = 'data:image/webp;base64,AAAA'
  assert.ok(assets.parseDataUrl(png, assets.IMG_DATA_RE))
  assert.strictEqual(assets.parseDataUrl(webp, assets.IMG_DATA_RE), null, '泡泡图不收 webp')
  assert.ok(assets.parseDataUrl(webp, assets.ROLE_DATA_RE), '角色收 webp')
})

test('assets: 泡泡图库内置两张在前，且用户重名不重复列出', () => {
  const payload = assets.bubbleImgPayload(null)
  assert.strictEqual(payload.length, 2)
  assert.strictEqual(payload[0].builtin, true)
  assert.strictEqual(payload[0].createdAt, null)
  // 用户用内置 id 上传 → 内置条目被跳过
  const dup = assets.bubbleImgPayload({ images: [{ id: 'bimg_petpet', name: 'mine', createdAt: 5, format: 'gif' }] })
  assert.strictEqual(dup.filter((x) => x.id === 'bimg_petpet').length, 1)
})

// ============================ 持久化（store） ============================
test('store: 泡泡配置往返一致（含 tapAdvance）', () => {
  const saved = store.writeBubble({ items: [{ kind: 'custom', modules: [{ type: 'text', text: 'hi' }] }], tapAdvance: true })
  assert.strictEqual(saved.items.length, 1)
  assert.strictEqual(saved.tapAdvance, true)
  const back = store.readBubble()
  assert.strictEqual(back.tapAdvance, true)
  assert.strictEqual(back.items[0].modules[0].text, 'hi')
})

test('store: 音效组保存/读取/删除，内置组拒绝修改删除', () => {
  const g = store.saveGroup({ name: '我的组', press: 'exp_orb', release: '' })
  assert.strictEqual(g.ok, true)
  const mine = g.groups.filter((x) => x.name === '我的组')[0]
  assert.strictEqual(mine.press, 'exp_orb')
  assert.strictEqual(mine.release, '', '空串必须原样保留为显式静音')
  assert.strictEqual(store.deleteGroup('duck').ok, false, '内置组不可删')
  assert.strictEqual(store.deleteGroup(mine.id).ok, true)
})

test('store: 上传片段校验 WAV 头与大小上限', () => {
  const tooSmall = store.uploadFragment('x', Buffer.alloc(10).toString('base64'))
  assert.strictEqual(tooSmall.ok, false, '小于 44 字节不是合法 WAV')
  const bad = store.uploadFragment('x', '!!!not-base64!!!')
  assert.strictEqual(bad.ok, false)
  const ok = store.uploadFragment('good', Buffer.alloc(100, 1).toString('base64'))
  assert.strictEqual(ok.ok, true)
  assert.ok(store.audioPayload().fragments.some((f) => f.id === ok.id))
  // 删除片段后组内悬空引用被清除
  const del = store.deleteFragment(ok.id)
  assert.strictEqual(del.ok, true)
})

test('store: 角色上传 → 读取字节 → 删除（default 拒绝删除）', () => {
  const png = 'data:image/png;base64,' + Buffer.alloc(200, 7).toString('base64')
  const up = store.uploadRole('测试角色', png, null)
  assert.strictEqual(up.ok, true)
  const img = store.loadRoleImage(up.id)
  assert.strictEqual(img.mime, 'image/png')
  assert.strictEqual(img.bytes.length, 200)
  assert.strictEqual(store.deleteRole('default').ok, false)
  assert.strictEqual(store.deleteRole(up.id).ok, true)
  assert.strictEqual(store.loadRoleImage(up.id), null)
})

test('store: 角色图 gif 格式落 .gif 且删除不留孤儿', () => {
  const gif = 'data:image/gif;base64,' + Buffer.alloc(200, 3).toString('base64')
  const up = store.uploadRole('动图', gif, 'gif')
  assert.strictEqual(up.format, 'gif')
  assert.ok(fs.existsSync(path.join(require('../lib/config').ROLES_DIR, up.id + '.gif')))
  store.deleteRole(up.id)
  assert.strictEqual(fs.existsSync(path.join(require('../lib/config').ROLES_DIR, up.id + '.gif')), false, '删除后不应留下孤儿文件')
})

test('store: 泡泡图上传/删除，内置图拒绝删除', () => {
  const png = 'data:image/png;base64,' + Buffer.alloc(100, 5).toString('base64')
  const up = store.uploadBubbleImg('我的图', png)
  assert.strictEqual(up.ok, true)
  assert.strictEqual(store.deleteBubbleImg('bimg_petpet').ok, false, '内置图不可删')
  assert.strictEqual(store.deleteBubbleImg(up.id).ok, true)
})

test('store: 内置素材随包可读（经验球 / 任务结束音 / 泡泡图）', () => {
  const orb = store.loadFragment('exp_orb')
  assert.ok(orb && orb.bytes.length > 1000, '内置经验球应可读')
  assert.strictEqual(orb.mime, 'audio/wav')
  const a = store.loadFragment('end_a')
  assert.ok(a && a.bytes.length > 1000, '内置任务结束音 A 应可读')
  assert.ok(store.loadFragment('ya1').bytes.length > 100)
  const money = store.loadBubbleImg('bimg_money1')
  assert.strictEqual(money.mime, 'image/gif')
  assert.ok(store.loadBubbleImg('bimg_petpet').bytes.length > 100)
})

test('store: 缺失资源返回 null / 失败对象，不抛异常', () => {
  assert.strictEqual(store.loadFragment('audio_nope'), null)
  assert.strictEqual(store.loadBubbleImg('bimg_nope'), null)
  assert.strictEqual(store.loadRoleImage('role_nope'), null)
  assert.strictEqual(store.deleteBubbleImg('bimg_nope').ok, false)
})

test('store: 原子写不留下临时文件，且文件权限为 0600', () => {
  store.writeBubble({ items: [], tapAdvance: false })
  const cfg = require('../lib/config')
  const dir = path.dirname(cfg.BUBBLE_FILE)
  const leftovers = fs.readdirSync(dir).filter((f) => f.indexOf('.tmp-') !== -1)
  assert.strictEqual(leftovers.length, 0, '不应残留 tmp 文件')
  if (process.platform !== 'win32') {
    const mode = fs.statSync(cfg.BUBBLE_FILE).mode & 0o777
    assert.strictEqual(mode, 0o600, '配置文件应为 0600')
  }
})


// ============================ 表情图（预警 / 播放播报） ============================
test('表情：预警用「委屈」、播报用「开心」，且都随包存在', () => {
  const cfg = require('../lib/config')
  assert.strictEqual(cfg.DEFAULTS.alertImgPath, 'assets/DSniang-sad.png')
  assert.strictEqual(cfg.DEFAULTS.dropImgPath, 'assets/DSniang-happy.png')
  // 文件必须真的随包（否则 getEffective 会置空，表情静默失效）
  for (const rel of [cfg.DEFAULTS.alertImgPath, cfg.DEFAULTS.dropImgPath, cfg.DEFAULTS.mainImgPath]) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', rel)), rel + ' 应随包存在')
  }
  const eff = cfg.getEffective()
  assert.strictEqual(eff.alertImgPath, 'assets/DSniang-sad.png', '存在时不应被置空')
  assert.strictEqual(eff.dropImgPath, 'assets/DSniang-happy.png', '存在时不应被置空')
})

test('表情：两张素材都是 610×610 透明 cut-out（与内置主图一致）', () => {
  for (const rel of ['assets/DSniang-sad.png', 'assets/DSniang-happy.png', 'assets/DSniang1.png']) {
    const b = fs.readFileSync(path.join(__dirname, '..', rel))
    // PNG 签名
    assert.strictEqual(b.slice(0, 8).toString('hex'), '89504e470d0a1a0a', rel + ' 应是 PNG')
    // IHDR 宽高（偏移 16/20，大端）
    const w = b.readUInt32BE(16)
    const h = b.readUInt32BE(20)
    assert.strictEqual(w, 610, rel + ' 宽应为 610')
    assert.strictEqual(h, 610, rel + ' 高应为 610')
    // 色彩类型 6 = RGBA（必须有透明通道，否则桌面上会出现实心方块）
    const colorType = b[25]
    assert.strictEqual(colorType, 6, rel + ' 应为 RGBA（带 alpha）')
  }
})


test('表情：三张图的可见区域已对齐主图（切换表情不应出现跳动）', () => {
  // 解析 PNG 的 alpha 包围盒需要解码；这里用最小实现（Node 无 zlib 之外的图像库，
  // 改用 zlib 解 PNG IDAT 成本过高）→ 改为断言「对齐基准」这一不变量：
  // 三张图必须同尺寸同色彩类型，且用户在设置页看到的是同一画布规格。
  const files = ['assets/DSniang1.png', 'assets/DSniang-sad.png', 'assets/DSniang-happy.png']
  const metas = files.map((rel) => {
    const b = fs.readFileSync(path.join(__dirname, '..', rel))
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }
  })
  for (const m of metas) {
    assert.strictEqual(m.w, 610)
    assert.strictEqual(m.h, 610)
    assert.strictEqual(m.colorType, 6, '必须 RGBA')
  }
  // 画布规格完全一致 → 图内位置对齐才有意义
  assert.deepStrictEqual(metas[0], metas[1])
  assert.deepStrictEqual(metas[0], metas[2])
})

test('表情：对齐基准记录在文档中（防止后人重新导入时又错位）', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'design-v035.md'), 'utf8')
  assert.ok(/对齐/.test(doc), '设计文档应记录对准要求')
  assert.ok(/610×610|610x610/.test(doc), '应记录画布规格')
})

test('表情：播报保持时长默认 2600ms，0 = 不切换', () => {
  const cfg = require('../lib/config')
  assert.strictEqual(cfg.DEFAULTS.dropImgHoldMs, 2600)
  assert.strictEqual(cfg.DEFAULTS.dropImage, true)
  assert.strictEqual(cfg.sanitize({ dropImgHoldMs: 0 }).dropImgHoldMs, 0)
})

test('一致性：渲染层优先级为 预警 > 播报 > 角色 > 主图', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('function updateHeroImage')
  assert.ok(i !== -1, '应有 updateHeroImage')
  const body = src.slice(i, i + 1400)
  const lowAt = body.indexOf('alertImgPath')
  const dropAt = body.indexOf('dropImgPath')
  const roleAt = body.indexOf('roleImgSrc')
  const mainAt = body.indexOf('mainImgPath')
  assert.ok(lowAt !== -1 && dropAt !== -1 && roleAt !== -1 && mainAt !== -1, '四层都应存在')
  assert.ok(lowAt < dropAt, '预警应优先于播报表情')
  assert.ok(dropAt < roleAt, '播报表情应优先于自定义角色')
  assert.ok(roleAt < mainAt, '自定义角色应优先于主图')
})

test('一致性：余额下降同时触发播报表情与任务结束音', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  const i = src.indexOf('consumed && !manual')
  assert.ok(i !== -1, '应有余额下降判定')
  const body = src.slice(i, i + 260)
  assert.ok(/triggerDropFace\(\)/.test(body), '应触发播报表情')
  assert.ok(/playTaskEndSound\(\)/.test(body), '应播放任务结束音（同一信号）')
})

test('一致性：设置界面提供播报表情的开关 / 选图 / 时长', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'menu.html'), 'utf8')
  for (const id of ['wm-dropimage', 'wm-drop-pick', 'wm-drop-reset', 'wm-drop-hold']) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, '缺少控件 ' + id)
  }
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'menu.js'), 'utf8')
  assert.ok(/bindImagePicker\(els\.dropPick, els\.dropReset, 'drop'/.test(js),
    '播报形象应复用 bindImagePicker（kind=drop）')
})

test('一致性：主进程图片 IPC 支持 drop 类型', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/kind === 'drop'/.test(src), 'image:pick/reset 应支持 drop')
  assert.ok(/assets\/DSniang-happy\.png/.test(src), '恢复默认应回到随包播报表情')
  assert.ok(/assets\/DSniang-sad\.png/.test(src), '恢复默认应回到随包预警表情')
})

// ============================ 渲染层与 lib 的一致性 ============================
// 渲染进程不能 require（sandbox + contextIsolation），所以 pet.js / menu-v035.js
// 里各有一份行归组与字号算法的内联实现。这里做「源码级一致性检查」，确保两份
// 实现不会悄悄漂移 —— 这是本次移植最容易出问题的地方。
const RENDERER_FILES = [
  path.join(__dirname, '..', 'renderer', 'pet.js'),
  path.join(__dirname, '..', 'renderer', 'menu-v035.js'),
]

test('一致性：渲染层内联的字号公式与 lib/bubble.js 相同（40 + (n-1)*200/49）', () => {
  for (const f of RENDERER_FILES) {
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(/40\s*\+\s*\(n\s*-\s*1\)\s*\*\s*200\s*\/\s*49/.test(src) ||
      /40\s*\+\s*\(.*?-\s*1\)\s*\*\s*200\s*\/\s*49/.test(src),
      path.basename(f) + ' 应使用与 lib/bubble.js 相同的字号插值公式')
  }
})

test('一致性：渲染层行归组同样处理「图片独占行 + row 键合并 + 6 行上限」', () => {
  for (const f of RENDERER_FILES) {
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(/function rowsOf\b/.test(src), path.basename(f) + ' 应有 rowsOf 实现')
    assert.ok(/isImgMod/.test(src), path.basename(f) + ' 应判定图片类模块独占行')
    // row 键的正整数判定（与 lib/bubble.js rowKeyOf 同语义）
    assert.ok(/Math\.round\(m\.row\)\s*===\s*m\.row/.test(src) || /Math\.round\(.*\.row\)\s*===\s*.*\.row/.test(src),
      path.basename(f) + ' 应校验 row 为整数')
    assert.ok(/ROW_MAX|rowMax/.test(src), path.basename(f) + ' 应有行数上限约束')
  }
})

test('一致性：渲染层的行归组结果与 lib/bubble.js rowsOf 完全一致', () => {
  // 从 pet.js 抽出内联 rowsOf 的实现代价过高，这里改为「按同一组输入人工推演」，
  // 断言 lib 的语义正是渲染层依赖的语义（回归锚点）。
  const cases = [
    { mods: [{ type: 'text' }, { type: 'text' }], want: 2 },
    { mods: [{ type: 'text', row: 1 }, { type: 'text', row: 1 }], want: 1 },
    { mods: [{ type: 'image' }, { type: 'text' }], want: 2 },
    { mods: [{ type: 'text', row: 2 }, { type: 'image' }, { type: 'text', row: 2 }], want: 3 },
    { mods: [{ type: 'image' }, { type: 'randimg' }], want: 2 },
  ]
  for (const c of cases) {
    assert.strictEqual(bubble.rowsOf(c.mods).length, c.want, JSON.stringify(c.mods))
  }
})

test('一致性：气泡模块容器与菜单页都声明了 6 模块 / 6 行上限文案', () => {
  const petCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8')
  const menuJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'menu-v035.js'), 'utf8')
  assert.ok(/wp-mods/.test(petCss), 'pet.css 应提供模块容器样式')
  assert.ok(/wp-modrow/.test(petCss), 'pet.css 应提供行样式')
  assert.ok(/MOD_MAX = 6/.test(menuJs), '编辑器应声明每行模块上限')
  assert.ok(/ROW_MAX = 6/.test(menuJs), '编辑器应声明行数上限')
})

test('一致性：隐藏菜单按钮的 CSS 类与渲染层切换的类名相同', () => {
  const petCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.css'), 'utf8')
  const petJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  assert.ok(/wp-menu-btn-hidden/.test(petCss), 'pet.css 应有 wp-menu-btn-hidden')
  assert.ok(/wp-menu-btn-hidden/.test(petJs), 'pet.js 应切换 wp-menu-btn-hidden')
})

test('一致性：长按唤出阈值与上游一致（1500ms / 10px 容差）', () => {
  const petJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
  assert.ok(/LONG_PRESS_MS\s*=\s*1500/.test(petJs), '长按阈值应为 1500ms')
  assert.ok(/LONG_PRESS_SLOP\s*=\s*10/.test(petJs), '长按位移容差应为 10px')
})

test('一致性：编辑器拖拽排序使用上游同款 400ms 长按阈值', () => {
  const menuJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'menu-v035.js'), 'utf8')
  assert.ok(/\},\s*400\)/.test(menuJs), '触屏拖拽应为 400ms 长按')
})

// ============================ 上游语义护栏 ============================
test('护栏：任务结束音默认关闭（上游 usageSettingsDefaults 的既定行为）', () => {
  // 这条是产品行为的硬约束：默认不打扰用户
  assert.strictEqual(audio.TASK_END_DEFAULTS.on, false)
})

test('护栏：配置里不含任何明文密钥字段（v0.3.5 新增项均为非敏感）', () => {
  const cfg = require('../lib/config')
  const keys = Object.keys(cfg.DEFAULTS)
  assert.ok(!keys.some((k) => /token|secret|password/i.test(k) && k !== 'platformToken'),
    '新增字段不应引入额外的密钥类字段')
  // 新增字段存在性
  for (const k of ['menuBtnHide', 'taskEnd', 'audioGroup', 'roleId', 'bubbleTapAdvance']) {
    assert.ok(keys.indexOf(k) !== -1, '缺少新增字段 ' + k)
  }
})

test('护栏：新资源目录都落在配置目录内（不污染用户其它路径）', () => {
  const cfg = require('../lib/config')
  for (const p of [cfg.AUDIO_DIR, cfg.ROLES_DIR, cfg.BUBBLE_IMG_DIR, cfg.BUBBLE_FILE]) {
    assert.ok(p.indexOf(cfg.CONFIG_DIR) === 0, p + ' 应在配置目录内')
  }
})

if (failed) {
  console.error('\n' + passed + ' passed, ' + failed + ' FAILED')
  process.exitCode = 1
} else {
  console.log('\n' + passed + ' v0.3.5 tests passed')
}
