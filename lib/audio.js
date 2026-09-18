'use strict'
// ---------------------------------------------------------------------------
// 音效库：音频片段 + 自定义音效组 + 任务结束音
// （移植自上游 lib/index.js PRESET_GROUPS/PRESET_FRAGMENTS + assets/whale-widget.js）
//
// 上游把索引放在 $DSH_HOME/whale-audio/audio.json、文件放同目录 <id>.wav。桌宠版
// 沿用同一模型，但落在自己的配置目录 ~/.config/whale-pet/audio/：
//   audio/audio.json          { version, groups: [...], fragments: [...] }
//   audio/<id>.wav            用户导入的片段（16bit PCM WAV）
//
// 槽位语义（关键，别搞反）：
//   press/release 的取值是「片段 id」或「空串」。
//   · 空串 '' → 该事件**显式静音**（不发声）
//   · 字段缺失（undefined/null）→ 视为旧数据，回退到内置预设
//   这条区别在上游是血泪教训：早期版本把「缺失」当「静音」，导致只有一个音
//   的音效组永久不发声。
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')

const AUDIO_VERSION = 1
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024   // 上游 audio.json 上限 8MB（base64 前）
const MAX_NAME = 40
const MAX_GROUP_NAME = 20

// 内置音效组（不可删、不可改）
const PRESET_GROUPS = {
  duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2', preset: true },
  fx1: { id: 'fx1', name: '音效1', press: 'd1', release: 'd2', preset: true },
}

// 内置片段（不可删）。exp_orb / end_a 随包发布的 wav，是任务结束音的默认候选。
const PRESET_FRAGMENTS = {
  ya1: { id: 'ya1', name: '小黄鸭·按下', preset: true, mime: 'audio/mpeg' },
  ya2: { id: 'ya2', name: '小黄鸭·松开', preset: true, mime: 'audio/mpeg' },
  d1: { id: 'd1', name: '音效1·按下', preset: true, mime: 'audio/mpeg' },
  d2: { id: 'd2', name: '音效1·松开', preset: true, mime: 'audio/mpeg' },
  exp_orb: { id: 'exp_orb', name: 'Minecraft·经验球', preset: true, mime: 'audio/wav' },
  end_a: { id: 'end_a', name: 'A', preset: true, mime: 'audio/wav' },
}

// 随包内置片段的相对路径（相对应用根目录）
const BUILTIN_FRAGMENT_FILES = {
  ya1: 'assets/Ya1.mp3',
  ya2: 'assets/Ya2.mp3',
  d1: 'assets/D1.mp3',
  d2: 'assets/D2.mp3',
  exp_orb: 'assets/minecraft-exp-orb.wav',
  end_a: 'assets/task-end-a.wav',
}

// 任务结束音默认值（上游 usageSettingsDefaults().taskEnd）
// 默认**关闭**，但默认已选中内置 Minecraft·经验球 —— 打开即用。
const TASK_END_DEFAULTS = { on: false, sel: 'frag:exp_orb' }

const FRAG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function defaultIndex() {
  return { version: AUDIO_VERSION, groups: [], fragments: [] }
}

function sanitizeName(v, max, def) {
  const s = String(v === undefined || v === null ? '' : v).trim().slice(0, max)
  return s || def
}

// 便捷：按片段名规则消毒（默认「未命名音频」）
function sanitizeFragmentName(v) {
  return sanitizeName(v, MAX_NAME, '未命名音频')
}

// 合法片段 id：内置或用户库中的 id
function isPresetFragment(id) {
  return Object.prototype.hasOwnProperty.call(PRESET_FRAGMENTS, id)
}

function isPresetGroup(id) {
  return Object.prototype.hasOwnProperty.call(PRESET_GROUPS, id)
}

// 新 id（上游 'audio_' / 'group_' + base36 时间戳 + 随机后缀）
function newId(prefix, rnd) {
  const random = typeof rnd === 'function' ? rnd : Math.random
  return prefix + Date.now().toString(36) + '_' + random().toString(36).slice(2, 8)
}

// 索引消毒：只保留结构正确的条目
function sanitizeIndex(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const out = defaultIndex()
  const seen = {}
  const frags = Array.isArray(d.fragments) ? d.fragments : []
  for (let i = 0; i < frags.length && out.fragments.length < 200; i++) {
    const f = frags[i] && typeof frags[i] === 'object' ? frags[i] : {}
    const id = String(f.id || '')
    if (!FRAG_ID_RE.test(id) || seen[id] || isPresetFragment(id)) continue
    seen[id] = true
    out.fragments.push({ id: id, name: sanitizeName(f.name, MAX_NAME, '未命名音频'), createdAt: Number(f.createdAt) || 0 })
  }
  const fragIds = {}
  for (let i = 0; i < out.fragments.length; i++) fragIds[out.fragments[i].id] = true
  const groups = Array.isArray(d.groups) ? d.groups : []
  const seenG = {}
  for (let i = 0; i < groups.length && out.groups.length < 100; i++) {
    const g = groups[i] && typeof groups[i] === 'object' ? groups[i] : {}
    const id = String(g.id || '')
    if (!FRAG_ID_RE.test(id) || seenG[id] || isPresetGroup(id)) continue
    seenG[id] = true
    // 槽位：'' 保留为显式静音；合法片段 id 保留；其它（含缺失）视为「未设置」
    const slot = function (v) {
      if (v === '') return ''
      if (typeof v === 'string' && (isPresetFragment(v) || fragIds[v])) return v
      return undefined
    }
    const p = slot(g.press)
    const r = slot(g.release)
    const item = {
      id: id,
      name: sanitizeName(g.name, MAX_GROUP_NAME, '未命名音效组'),
    }
    if (p !== undefined) item.press = p
    if (r !== undefined) item.release = r
    item.pinnedAt = Number(g.pinnedAt) > 0 ? Number(g.pinnedAt) : null
    item.createdAt = Number(g.createdAt) || 0
    out.groups.push(item)
  }
  return out
}

// 音效组排序（上游 audioGroupsPayload）：
// 置顶的自定义组(按 pinnedAt 倒序) → 内置预设 → 未置顶的自定义组(按 createdAt 倒序)
function sortGroups(groups) {
  const list = Array.isArray(groups) ? groups.slice() : []
  const pinned = list.filter(function (g) { return Number(g.pinnedAt) > 0 })
    .sort(function (a, b) { return Number(b.pinnedAt) - Number(a.pinnedAt) })
  const rest = list.filter(function (g) { return !(Number(g.pinnedAt) > 0) })
    .sort(function (a, b) { return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) })
  const presets = Object.keys(PRESET_GROUPS).map(function (k) {
    const g = PRESET_GROUPS[k]
    return { id: g.id, name: g.name, press: g.press, release: g.release, preset: true, pinned: false, pinnedAt: null, createdAt: 0 }
  })
  return pinned.map(function (g) {
    return { id: g.id, name: g.name, press: g.press === undefined ? null : g.press, release: g.release === undefined ? null : g.release, preset: false, pinned: true, pinnedAt: g.pinnedAt, createdAt: g.createdAt }
  }).concat(presets, rest.map(function (g) {
    return { id: g.id, name: g.name, press: g.press === undefined ? null : g.press, release: g.release === undefined ? null : g.release, preset: false, pinned: false, pinnedAt: null, createdAt: g.createdAt }
  }))
}

function fragmentsPayload(index) {
  const presets = Object.keys(PRESET_FRAGMENTS).map(function (k) {
    const f = PRESET_FRAGMENTS[k]
    return { id: f.id, name: f.name, preset: true }
  })
  const idx = sanitizeIndex(index)
  const customs = idx.fragments.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) })
    .map(function (f) { return { id: f.id, name: f.name, preset: false, createdAt: f.createdAt } })
  return presets.concat(customs)
}

// ------------------------------------------------------------------ 槽位解析
// 上游 groupFragmentId：把「组 + 槽位」解析成实际要播放的片段 id。
// 返回 '' = 显式静音（调用方必须**不要**发声）。
function groupFragmentId(index, groupId, slot) {
  const idx = sanitizeIndex(index)
  const custom = idx.groups.filter(function (g) { return g.id === groupId })[0]
  if (custom) {
    const v = custom[slot]
    if (v === '') return ''                                  // 显式静音
    if (typeof v === 'string' && v) {
      if (isPresetFragment(v)) return v
      const has = idx.fragments.some(function (f) { return f.id === v })
      if (has) return v
    }
    // 该槽位未设置 → 回退内置小黄鸭（与上游一致）
    return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
  }
  const preset = PRESET_GROUPS[groupId]
  if (preset) return preset[slot]
  return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
}

// 片段 MIME（上游 fragmentMime）：内置按声明，用户导入一律 audio/wav。
// MIME 必须与实际字节一致，否则解码/播放会异常。
function fragmentMime(fragId) {
  if (isPresetFragment(fragId)) return PRESET_FRAGMENTS[fragId].mime
  return 'audio/wav'
}

// 内置片段 → 组+槽位 的映射（上游 loadAudioFragmentBytes 的第二级回退）
const PRESET_SLOT_MAP = {
  ya1: ['duck', 'press'], ya2: ['duck', 'release'],
  d1: ['fx1', 'press'], d2: ['fx1', 'release'],
}

// 解析内置片段的磁盘路径（相对 appRoot）
function builtinFragmentPath(appRoot, fragId) {
  const rel = BUILTIN_FRAGMENT_FILES[fragId]
  if (!rel) return null
  return path.join(appRoot, rel)
}

// 用户片段的磁盘路径（内置片段返回 null）
function userFragmentPath(dir, fragId) {
  if (typeof fragId !== 'string' || !FRAG_ID_RE.test(fragId)) return null
  if (isPresetFragment(fragId)) return null
  return path.join(dir, fragId + '.wav')
}

// ------------------------------------------------------------- 任务结束音
// sel 取值语法（上游）：
//   'frag:<片段id>'            播放单个音频片段
//   'preset:<组id>:<press|release>'  播放内置组的某一槽
//   'grp:<组id>'               模拟一次完整点按（先 press，结束再 release）
function parseTaskEndSel(sel) {
  const s = String(sel === undefined || sel === null ? '' : sel)
  if (s.indexOf('frag:') === 0) {
    const id = s.slice(5)
    return FRAG_ID_RE.test(id) ? { kind: 'frag', fragment: id } : null
  }
  if (s.indexOf('preset:') === 0) {
    const parts = s.split(':')
    if (parts.length < 3) return null
    const set = parts[1]
    const slot = parts[2] === 'release' ? 'release' : 'press'
    if (!isPresetGroup(set)) return null
    return { kind: 'preset', group: set, slot: slot, fragment: PRESET_GROUPS[set][slot] }
  }
  if (s.indexOf('grp:') === 0) {
    const id = s.slice(4)
    return FRAG_ID_RE.test(id) ? { kind: 'group', group: id } : null
  }
  return null
}

function sanitizeTaskEnd(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const on = d.on === true
  let sel = typeof d.sel === 'string' ? d.sel : ''
  if (!parseTaskEndSel(sel)) sel = TASK_END_DEFAULTS.sel
  const pins = Array.isArray(d.pins) ? d.pins.filter(function (p) { return typeof p === 'string' && parseTaskEndSel(p) }).slice(0, 30) : []
  return { on: on, sel: sel, pins: pins }
}

// 把任务结束音选择解析成「要依次播放的片段序列」。
// 返回片段 id 数组：长度 0 = 静音；长度 1 = 单体；长度 2 = 连播（press→release）。
// 这正是上游 playTaskEndGroupClick 的语义：两个槽都空则静默返回，只空一个就
// 只播另一个（**不要**因为 press 为空就整个 return —— 那会让只有 release 的组
// 永远不发声）。
function taskEndSequence(index, sel) {
  const parsed = parseTaskEndSel(sel)
  if (!parsed) return []
  if (parsed.kind === 'frag') return [parsed.fragment]
  if (parsed.kind === 'preset') return parsed.fragment ? [parsed.fragment] : []
  // 组：分别解析两个槽
  const p = groupFragmentId(index, parsed.group, 'press')
  const r = groupFragmentId(index, parsed.group, 'release')
  const out = []
  if (p) out.push(p)
  if (r) out.push(r)
  return out
}

// 每次点按的播放状态机（v729 修复的行为）：
// 状态清零必须**先于**「没有 press 音频就返回」的短路，否则只有一个音的音效组
// 只会响一次，之后永久静音。
function newPlaybackState() {
  return { pressEnded: false, releasePlayed: false }
}

function beginPress(state) {
  // 先重置状态，再判断是否有音源 —— 顺序不能反
  state.pressEnded = false
  state.releasePlayed = false
  return { playPress: true }
}

module.exports = {
  AUDIO_VERSION, MAX_FRAGMENT_BYTES, MAX_NAME, MAX_GROUP_NAME,
  PRESET_GROUPS, PRESET_FRAGMENTS, BUILTIN_FRAGMENT_FILES, PRESET_SLOT_MAP,
  TASK_END_DEFAULTS, FRAG_ID_RE,
  defaultIndex, sanitizeIndex, sortGroups, fragmentsPayload, isPresetFragment,
  isPresetGroup, newId, sanitizeName, sanitizeFragmentName, groupFragmentId,
  fragmentMime, builtinFragmentPath,
  userFragmentPath, parseTaskEndSel, sanitizeTaskEnd, taskEndSequence,
  newPlaybackState, beginPress,
}
