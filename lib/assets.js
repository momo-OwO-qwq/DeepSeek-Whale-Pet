'use strict'
// ---------------------------------------------------------------------------
// 资源库：自定义角色图 / 泡泡图库
// （移植自上游 lib/index.js 的 whale-roles 与 whale-bubble-imgs 两个资源目录）
//
// 上游把索引与文件放在 $DSH_HOME/whale-roles/、$DSH_HOME/whale-bubble-imgs/；
// 桌宠版落在 ~/.config/whale-pet/roles/ 与 ~/.config/whale-pet/bubble-imgs/。
//
// 索引结构（与上游一致）：
//   roles.json       { version:1, roles:[{ id, name, format, pinnedAt, createdAt }] }
//   bubble-imgs.json { version:1, images:[{ id, name, format, createdAt }] }
//
// 内置项（不可删）：
//   角色 default = 应用内 assets/DSniang1.png
//   泡泡图 bimg_petpet / bimg_money1 = 应用内 assets/ 的两张 gif
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')

const ROLES_VERSION = 1
const IMG_VERSION = 1
const ROLE_DEFAULT_ID = 'default'
const ROLE_MAX_BYTES = 20 * 1024 * 1024   // 上游 20MB
const IMG_MAX_BYTES = 8 * 1024 * 1024     // 上游 8MB
const MAX_NAME = 20
const MAX_IMG_NAME = 40

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// 角色接受 png/jpeg/webp/gif；泡泡图只接受 png/gif（上游行为）
const ROLE_DATA_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/
const IMG_DATA_RE = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/

// 内置泡泡图（随包 GIF）。petpet 与 rua.gif 字节相同（已 md5 核对），沿用沿用同名文件。
const DEFAULT_BUBBLE_IMGS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'assets/rua.gif', format: 'gif' },
  { id: 'bimg_money1', name: 'money1', file: 'assets/bubble-money1.gif', format: 'gif' },
]

function newId(prefix, rnd) {
  const random = typeof rnd === 'function' ? rnd : Math.random
  return prefix + Date.now().toString(36) + '_' + random().toString(36).slice(2, 8)
}

function sanitizeName(v, max, def) {
  const s = String(v === undefined || v === null ? '' : v).trim().slice(0, max)
  return s || def
}

// 文件扩展名（上游 roleFileExt：gif 之外一律 png；APNG 也是 png 容器）
function roleFileExt(format) {
  return format === 'gif' ? 'gif' : 'png'
}

// ---------------------------------------------------------------- 角色索引
function defaultRolesIndex() {
  return {
    version: ROLES_VERSION,
    roles: [{ id: ROLE_DEFAULT_ID, name: '小鲸鱼', format: 'png', pinnedAt: 1, createdAt: 0 }],
  }
}

function sanitizeRoles(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const out = defaultRolesIndex()
  out.roles = []
  const src = Array.isArray(d.roles) ? d.roles : []
  const seen = {}
  for (let i = 0; i < src.length && out.roles.length < 100; i++) {
    const r = src[i] && typeof src[i] === 'object' ? src[i] : {}
    const id = String(r.id || '')
    if (!ID_RE.test(id) || seen[id]) continue
    seen[id] = true
    const format = r.format === 'gif' ? 'gif' : (r.format === 'apng' ? 'apng' : 'png')
    if (id === ROLE_DEFAULT_ID) {
      // 内置角色：名字/格式固定，只保留置顶位（幂等，重复消毒不会产生第二条）
      out.roles.push({ id: ROLE_DEFAULT_ID, name: '小鲸鱼', format: 'png', pinnedAt: 1, createdAt: 0 })
    } else {
      out.roles.push({
        id: id,
        name: sanitizeName(r.name, MAX_NAME, '新角色'),
        format: format,
        pinnedAt: Number(r.pinnedAt) > 0 ? Number(r.pinnedAt) : null,
        createdAt: Number(r.createdAt) || 0,
      })
    }
  }
  // 确保 default 存在（上游会 unshift 回来）
  if (!out.roles.some(function (r) { return r.id === ROLE_DEFAULT_ID })) {
    out.roles.unshift({ id: ROLE_DEFAULT_ID, name: '小鲸鱼', format: 'png', pinnedAt: 1, createdAt: 0 })
  }
  return out
}

// 排序（上游 sortRoles）：置顶按 pinnedAt 倒序 → 其余按 createdAt 倒序
function sortRoles(index) {
  const idx = sanitizeRoles(index)
  const pinned = idx.roles.filter(function (r) { return Number(r.pinnedAt) > 0 })
    .sort(function (a, b) { return Number(b.pinnedAt) - Number(a.pinnedAt) })
  const rest = idx.roles.filter(function (r) { return !(Number(r.pinnedAt) > 0) })
    .sort(function (a, b) { return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) })
  return pinned.concat(rest)
}

function roleFilePath(dir, id, format) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id === ROLE_DEFAULT_ID) return null
  return path.join(dir, id + '.' + roleFileExt(format))
}

// ------------------------------------------------------------ 泡泡图库索引
function defaultImgIndex() {
  return { version: IMG_VERSION, images: [] }
}

function sanitizeImgs(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const out = defaultImgIndex()
  const src = Array.isArray(d.images) ? d.images : []
  const seen = {}
  for (let i = 0; i < src.length && out.images.length < 200; i++) {
    const im = src[i] && typeof src[i] === 'object' ? src[i] : {}
    const id = String(im.id || '')
    if (!ID_RE.test(id) || seen[id]) continue
    seen[id] = true
    out.images.push({
      id: id,
      name: sanitizeName(im.name, MAX_IMG_NAME, '未命名图片'),
      format: im.format === 'gif' ? 'gif' : 'png',
      createdAt: Number(im.createdAt) || 0,
    })
  }
  return out
}

// 内置图在前，用户图按 createdAt 倒序（上游 bubbleImgPayload）
function bubbleImgPayload(index) {
  const idx = sanitizeImgs(index)
  const userIds = {}
  for (let i = 0; i < idx.images.length; i++) userIds[idx.images[i].id] = true
  const builtin = DEFAULT_BUBBLE_IMGS.filter(function (b) { return !userIds[b.id] })
    .map(function (b) { return { id: b.id, name: b.name, format: b.format, createdAt: null, builtin: true } })
  const user = idx.images.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) })
    .map(function (im) { return { id: im.id, name: im.name, format: im.format, createdAt: im.createdAt } })
  return builtin.concat(user)
}

function bubbleImgPath(dir, id, format) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  return path.join(dir, id + '.' + (format === 'gif' ? 'gif' : 'png'))
}

function builtinImgDef(id) {
  for (let i = 0; i < DEFAULT_BUBBLE_IMGS.length; i++) if (DEFAULT_BUBBLE_IMGS[i].id === id) return DEFAULT_BUBBLE_IMGS[i]
  return null
}

// 从 dataURL 解析 { format, bytes }；不合法返回 null
function parseDataUrl(dataUrl, re) {
  const m = String(dataUrl || '').match(re)
  if (!m) return null
  let format = m[1] === 'jpg' ? 'jpeg' : m[1]
  if (format === 'png' && dataUrl.indexOf('data:image/apng') === 0) format = 'apng'
  return { mime: format, base64: m[2] }
}

module.exports = {
  ROLES_VERSION, IMG_VERSION, ROLE_DEFAULT_ID, ROLE_MAX_BYTES, IMG_MAX_BYTES,
  MAX_NAME, MAX_IMG_NAME, ID_RE, ROLE_DATA_RE, IMG_DATA_RE, DEFAULT_BUBBLE_IMGS,
  newId, sanitizeName, roleFileExt, defaultRolesIndex, sanitizeRoles, sortRoles,
  roleFilePath, defaultImgIndex, sanitizeImgs, bubbleImgPayload, bubbleImgPath,
  builtinImgDef, parseDataUrl,
}
