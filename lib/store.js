'use strict'
// ---------------------------------------------------------------------------
// 新功能的持久化层：泡泡配置 / 音效库 / 角色库 / 泡泡图库
//
// 这一层只做「读盘 → 消毒 → 返回」与「原子写」两件事，全部逻辑保持纯函数式，
// 方便 test/unit.test.js 在不启动 Electron 的情况下完整覆盖。
// 目录常量来自 lib/config.js（因此 WHALE_PET_HOME 重定向在测试里同样生效）。
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')
const config = require('./config')
const bubble = require('./bubble')
const audio = require('./audio')
const assets = require('./assets')

// 原子写：tmp + rename（与 lib/config.js 同款），0600
function atomicWrite(file, text, mode) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, text, { mode: mode === undefined ? 0o600 : mode })
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    return false
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

// ------------------------------------------------------------------ 泡泡配置
function readBubble() {
  return bubble.sanitize(readJson(config.BUBBLE_FILE))
}

function writeBubble(cfg) {
  const clean = bubble.sanitize(cfg)
  const ok = atomicWrite(config.BUBBLE_FILE, JSON.stringify(clean, null, 2))
  return ok ? clean : null
}

// ------------------------------------------------------------------ 音效库
function readAudioIndex() {
  return audio.sanitizeIndex(readJson(config.AUDIO_FILE))
}

function writeAudioIndex(index) {
  const clean = audio.sanitizeIndex(index)
  const ok = atomicWrite(config.AUDIO_FILE, JSON.stringify(clean, null, 2))
  return ok ? clean : null
}

// 音效库对外载荷（组按上游排序规则）
function audioPayload() {
  const idx = readAudioIndex()
  return {
    ok: true,
    groups: audio.sortGroups(idx.groups),
    fragments: audio.fragmentsPayload(idx),
  }
}

// 写入一个音频片段（base64 WAV）→ 返回 { ok, id } 或 { ok:false, error }
function uploadFragment(name, base64, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const m = String(base64 || '')
  if (!/^[A-Za-z0-9+/=]+$/.test(m)) return { ok: false, error: 'invalid wav data' }
  let buf
  try { buf = Buffer.from(m, 'base64') } catch (err) { return { ok: false, error: 'invalid wav data' } }
  // 44 字节 = WAV 头；上限 8MB（上游约束）
  if (buf.length < 44) return { ok: false, error: 'invalid wav data' }
  if (buf.length > audio.MAX_FRAGMENT_BYTES) return { ok: false, error: 'audio too large' }
  const idx = readAudioIndex()
  const id = audio.newId('audio_', o.rnd)
  const file = audio.userFragmentPath(config.AUDIO_DIR, id)
  if (!file) return { ok: false, error: 'invalid id' }
  try {
    fs.mkdirSync(config.AUDIO_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, buf, { mode: 0o600 })
  } catch (err) {
    return { ok: false, error: 'write failed' }
  }
  idx.fragments.push({ id: id, name: audio.sanitizeFragmentName(name), createdAt: Date.now() })
  writeAudioIndex(idx)
  return { ok: true, id: id }
}

// 保存音效组（新建或就地更新）→ 返回 { ok, groups }
function saveGroup(patch, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const idx = readAudioIndex()
  const name = String((patch && patch.name) || '').trim().slice(0, audio.MAX_GROUP_NAME) || '未命名音效组'
  // 槽位解析：'' 保留为显式静音；合法片段 id 保留；其余（含缺失）不写该字段
  const validFrag = function (v) {
    if (v === '') return ''
    if (typeof v !== 'string' || !v) return undefined
    if (audio.isPresetFragment(v)) return v
    if (idx.fragments.some(function (f) { return f.id === v })) return v
    return undefined
  }
  const press = validFrag(patch && patch.press)
  const release = validFrag(patch && patch.release)
  const id = patch && typeof patch.id === 'string' ? patch.id : ''
  const existing = id ? idx.groups.filter(function (g) { return g.id === id })[0] : null
  if (existing) {
    existing.name = name
    if (press !== undefined) existing.press = press
    if (release !== undefined) existing.release = release
  } else {
    if (audio.isPresetGroup(id)) return { ok: false, error: 'cannot modify preset group' }
    const item = { id: audio.newId('group_', o.rnd), name: name, pinnedAt: null, createdAt: Date.now() }
    if (press !== undefined) item.press = press
    if (release !== undefined) item.release = release
    idx.groups.push(item)
  }
  const saved = writeAudioIndex(idx)
  return { ok: true, groups: audio.sortGroups(saved ? saved.groups : idx.groups) }
}

function deleteGroup(id) {
  if (audio.isPresetGroup(id)) return { ok: false, error: 'cannot delete preset group' }
  const idx = readAudioIndex()
  const before = idx.groups.length
  idx.groups = idx.groups.filter(function (g) { return g.id !== id })
  if (idx.groups.length === before) return { ok: false, error: 'group not found' }
  const saved = writeAudioIndex(idx)
  return { ok: true, groups: audio.sortGroups(saved ? saved.groups : idx.groups) }
}

function deleteFragment(id) {
  if (audio.isPresetFragment(id)) return { ok: false, error: 'cannot delete preset fragment' }
  const idx = readAudioIndex()
  const before = idx.fragments.length
  idx.fragments = idx.fragments.filter(function (f) { return f.id !== id })
  if (idx.fragments.length === before) return { ok: false, error: 'fragment not found' }
  const file = audio.userFragmentPath(config.AUDIO_DIR, id)
  if (file) { try { fs.unlinkSync(file) } catch (err) {} }
  // 同时把引用了该片段的槽位清成「未设置」（不静音，回退预设）—— 避免留下悬空引用
  for (let i = 0; i < idx.groups.length; i++) {
    const g = idx.groups[i]
    if (g.press === id) delete g.press
    if (g.release === id) delete g.release
  }
  const saved = writeAudioIndex(idx)
  return { ok: true, fragments: audio.fragmentsPayload(saved || idx), groups: audio.sortGroups(saved ? saved.groups : idx.groups) }
}

function pinGroup(id, pinned) {
  const idx = readAudioIndex()
  const g = idx.groups.filter(function (x) { return x.id === id })[0]
  if (!g) return { ok: false, error: 'group not found' }
  g.pinnedAt = pinned === true ? Date.now() : null
  const saved = writeAudioIndex(idx)
  return { ok: true, groups: audio.sortGroups(saved ? saved.groups : idx.groups) }
}

// 读取片段字节：内置优先，其次用户库。返回 { bytes, mime } 或 null
function loadFragment(fragId, appRoot) {
  const builtin = audio.builtinFragmentPath(appRoot || config.APP_ROOT, fragId)
  if (builtin) {
    try { return { bytes: fs.readFileSync(builtin), mime: audio.fragmentMime(fragId) } } catch (err) {}
  }
  const file = audio.userFragmentPath(config.AUDIO_DIR, fragId)
  if (!file) return null
  try { return { bytes: fs.readFileSync(file), mime: 'audio/wav' } } catch (err) { return null }
}

// ------------------------------------------------------------------ 角色库
function readRoles() {
  return assets.sanitizeRoles(readJson(config.ROLES_FILE))
}

function rolesPayload() {
  const idx = readRoles()
  return {
    ok: true,
    roles: assets.sortRoles(idx).map(function (r) {
      return {
        id: r.id, name: r.name, format: r.format,
        pinned: Number(r.pinnedAt) > 0, pinnedAt: r.pinnedAt || null,
        createdAt: r.createdAt || 0, builtin: r.id === assets.ROLE_DEFAULT_ID,
      }
    }),
  }
}

// 保存角色（base64 图片）→ { ok, id }
function uploadRole(name, dataUrl, declaredFormat, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const parsed = assets.parseDataUrl(dataUrl, assets.ROLE_DATA_RE)
  if (!parsed) return { ok: false, error: 'invalid image data' }
  let buf
  try { buf = Buffer.from(parsed.base64, 'base64') } catch (err) { return { ok: false, error: 'invalid image data' } }
  if (buf.length < 8) return { ok: false, error: 'invalid image data' }
  if (buf.length > assets.ROLE_MAX_BYTES) return { ok: false, error: 'image too large' }
  // APNG 的 dataURL MIME 是 image/png，必须由客户端显式声明
  const format = declaredFormat === 'gif' ? 'gif' : (declaredFormat === 'apng' ? 'apng' : (parsed.mime === 'gif' ? 'gif' : 'png'))
  const idx = readRoles()
  const id = assets.newId('role_', o.rnd)
  const file = assets.roleFilePath(config.ROLES_DIR, id, format)
  if (!file) return { ok: false, error: 'invalid id' }
  try {
    fs.mkdirSync(config.ROLES_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, buf, { mode: 0o600 })
  } catch (err) {
    return { ok: false, error: 'write failed' }
  }
  idx.roles.push({ id: id, name: assets.sanitizeName(name, assets.MAX_NAME, '新角色'), format: format, pinnedAt: null, createdAt: Date.now() })
  atomicWrite(config.ROLES_FILE, JSON.stringify(assets.sanitizeRoles(idx), null, 2))
  return { ok: true, id: id, format: format, roles: rolesPayload().roles }
}

function pinRole(id, pinned) {
  const idx = readRoles()
  const r = idx.roles.filter(function (x) { return x.id === id })[0]
  if (!r) return { ok: false, error: 'role not found' }
  r.pinnedAt = pinned === true ? Date.now() : null
  atomicWrite(config.ROLES_FILE, JSON.stringify(assets.sanitizeRoles(idx), null, 2))
  return { ok: true, roles: rolesPayload().roles }
}

function deleteRole(id) {
  if (id === assets.ROLE_DEFAULT_ID) return { ok: false, error: 'cannot delete default role' }
  const idx = readRoles()
  const r = idx.roles.filter(function (x) { return x.id === id })[0]
  if (!r) return { ok: false, error: 'role not found' }
  // 先按角色自己的 format 解析路径，再摘索引 —— 否则 .gif 会变成孤儿文件
  const file = assets.roleFilePath(config.ROLES_DIR, id, r.format)
  idx.roles = idx.roles.filter(function (x) { return x.id !== id })
  atomicWrite(config.ROLES_FILE, JSON.stringify(assets.sanitizeRoles(idx), null, 2))
  if (file) { try { fs.unlinkSync(file) } catch (err) {} }
  return { ok: true, roles: rolesPayload().roles }
}

// 角色图字节；default 用应用内主图
function loadRoleImage(id, appRoot) {
  if (id === assets.ROLE_DEFAULT_ID) {
    const main = path.join(appRoot || config.APP_ROOT, 'assets', 'DSniang1.png')
    try { return { bytes: fs.readFileSync(main), mime: 'image/png' } } catch (err) { return null }
  }
  const idx = readRoles()
  const r = idx.roles.filter(function (x) { return x.id === id })[0]
  if (!r) return null
  const file = assets.roleFilePath(config.ROLES_DIR, id, r.format)
  if (!file) return null
  try {
    return { bytes: fs.readFileSync(file), mime: r.format === 'gif' ? 'image/gif' : 'image/png' }
  } catch (err) { return null }
}

// ---------------------------------------------------------------- 泡泡图库
function readImgs() {
  return assets.sanitizeImgs(readJson(config.BUBBLE_IMG_FILE))
}

function bubbleImgsPayload() {
  return { ok: true, images: assets.bubbleImgPayload(readImgs()) }
}

function uploadBubbleImg(name, dataUrl, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const parsed = assets.parseDataUrl(dataUrl, assets.IMG_DATA_RE)
  if (!parsed) return { ok: false, error: 'invalid image data' }
  let buf
  try { buf = Buffer.from(parsed.base64, 'base64') } catch (err) { return { ok: false, error: 'invalid image data' } }
  if (buf.length < 64) return { ok: false, error: 'invalid image data' }
  if (buf.length > assets.IMG_MAX_BYTES) return { ok: false, error: 'image too large' }
  const format = parsed.mime === 'gif' ? 'gif' : 'png'
  const idx = readImgs()
  const id = assets.newId('bimg_', o.rnd)
  const file = assets.bubbleImgPath(config.BUBBLE_IMG_DIR, id, format)
  if (!file) return { ok: false, error: 'invalid id' }
  try {
    fs.mkdirSync(config.BUBBLE_IMG_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, buf, { mode: 0o600 })
  } catch (err) {
    return { ok: false, error: 'write failed' }
  }
  idx.images.push({ id: id, name: assets.sanitizeName(name, assets.MAX_IMG_NAME, '未命名图片'), format: format, createdAt: Date.now() })
  atomicWrite(config.BUBBLE_IMG_FILE, JSON.stringify(assets.sanitizeImgs(idx), null, 2))
  return { ok: true, id: id, images: bubbleImgsPayload().images }
}

function deleteBubbleImg(id) {
  const idx = readImgs()
  const im = idx.images.filter(function (x) { return x.id === id })[0]
  if (!im) {
    if (assets.builtinImgDef(id)) return { ok: false, error: 'cannot delete builtin image' }
    return { ok: false, error: 'image not found' }
  }
  idx.images = idx.images.filter(function (x) { return x.id !== id })
  atomicWrite(config.BUBBLE_IMG_FILE, JSON.stringify(assets.sanitizeImgs(idx), null, 2))
  const file = assets.bubbleImgPath(config.BUBBLE_IMG_DIR, id, im.format)
  if (file) { try { fs.unlinkSync(file) } catch (err) {} }
  return { ok: true, images: bubbleImgsPayload().images }
}

// 泡泡图字节：用户库优先，其次内置
function loadBubbleImg(id, appRoot) {
  const idx = readImgs()
  const im = idx.images.filter(function (x) { return x.id === id })[0]
  if (im) {
    const file = assets.bubbleImgPath(config.BUBBLE_IMG_DIR, id, im.format)
    if (file) {
      try { return { bytes: fs.readFileSync(file), mime: im.format === 'gif' ? 'image/gif' : 'image/png' } } catch (err) {}
    }
  }
  const def = assets.builtinImgDef(id)
  if (def) {
    const file = path.join(appRoot || config.APP_ROOT, def.file)
    try { return { bytes: fs.readFileSync(file), mime: def.format === 'gif' ? 'image/gif' : 'image/png' } } catch (err) {}
  }
  return null
}

module.exports = {
  atomicWrite, readJson,
  readBubble, writeBubble,
  readAudioIndex, writeAudioIndex, audioPayload, uploadFragment, saveGroup,
  deleteGroup, deleteFragment, pinGroup, loadFragment,
  readRoles, rolesPayload, uploadRole, pinRole, deleteRole, loadRoleImage,
  readImgs, bubbleImgsPayload, uploadBubbleImg, deleteBubbleImg, loadBubbleImg,
}
