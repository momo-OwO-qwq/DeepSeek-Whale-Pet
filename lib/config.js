'use strict'
// ---------------------------------------------------------------------------
// 配置管理：~/.config/whale-pet/config.json
// - 默认值 + 读时消毒（sanitize），保证任何字段都不会把渲染进程搞挂
// - 原子写入（tmp + rename），目录 0700 / 文件 0600（含 API Key，必须收紧权限）
// - 环境变量优先：DEEPSEEK_API_KEY / DEEPSEEK_PLATFORM_TOKEN 存在时覆盖文件值
// ---------------------------------------------------------------------------
const fs = require('fs')
const os = require('os')
const path = require('path')

const CONFIG_DIR = process.env.WHALE_PET_HOME || path.join(os.homedir(), '.config', 'whale-pet')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json')

const DEFAULTS = {
  apiKey: '',
  platformToken: '',
  scale: 1.0,               // 0.6 - 2.5
  soundSet: 'duck',         // duck | fx1
  volume: 0.8,              // 0 - 1
  usageMode: 'ledger',      // ledger | token
  peakMode: 'default',      // default | liangwen | qiangqiang
  peakText: true,           // 气泡里显示峰谷时段提示
  bubbleOn: true,
  idleFade: true,           // 闲置半透明
  refreshInterval: 60,      // 秒
  lowBalanceThreshold: 10,  // 元
  autostart: false,
  posX: null,               // 上次窗口位置（屏幕坐标）
  posY: null,
  posH: 'right',            // left | right | null
  posV: 'bottom',           // top | bottom | null
}

function num(v, lo, hi, def) {
  const n = Number(v)
  if (!isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

function sanitize(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS }
  if (typeof d.apiKey === 'string') cfg.apiKey = d.apiKey.trim()
  if (typeof d.platformToken === 'string') cfg.platformToken = d.platformToken.trim()
  if (d.scale !== undefined) cfg.scale = Math.round(num(d.scale, 0.6, 2.5, DEFAULTS.scale) * 10) / 10
  if (typeof d.soundSet === 'string') cfg.soundSet = d.soundSet === 'fx1' ? 'fx1' : 'duck'
  if (d.volume !== undefined) cfg.volume = Math.round(num(d.volume, 0, 1, DEFAULTS.volume) * 100) / 100
  if (typeof d.usageMode === 'string') cfg.usageMode = d.usageMode === 'token' ? 'token' : 'ledger'
  if (typeof d.peakMode === 'string') cfg.peakMode = ['liangwen', 'qiangqiang'].includes(d.peakMode) ? d.peakMode : 'default'
  if (typeof d.peakText === 'boolean') cfg.peakText = d.peakText
  if (typeof d.bubbleOn === 'boolean') cfg.bubbleOn = d.bubbleOn
  if (typeof d.idleFade === 'boolean') cfg.idleFade = d.idleFade
  if (d.refreshInterval !== undefined) cfg.refreshInterval = Math.round(num(d.refreshInterval, 5, 3600, DEFAULTS.refreshInterval))
  if (d.lowBalanceThreshold !== undefined) cfg.lowBalanceThreshold = Math.round(num(d.lowBalanceThreshold, 0, 1e9, DEFAULTS.lowBalanceThreshold) * 100) / 100
  if (typeof d.autostart === 'boolean') cfg.autostart = d.autostart
  if (d.posX !== null && d.posX !== undefined && isFinite(Number(d.posX))) cfg.posX = Math.round(Number(d.posX))
  if (d.posY !== null && d.posY !== undefined && isFinite(Number(d.posY))) cfg.posY = Math.round(Number(d.posY))
  if (typeof d.posH === 'string') cfg.posH = d.posH === 'left' ? 'left' : (d.posH === 'right' ? 'right' : null)
  if (typeof d.posV === 'string') cfg.posV = d.posV === 'top' ? 'top' : 'bottom'
  return cfg
}

function readFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return sanitize(parsed)
  } catch (err) {
    return null
  }
}

// 带环境变量覆盖的“有效配置”
function getEffective() {
  const cfg = readFile() || { ...DEFAULTS }
  const envKey = process.env.DEEPSEEK_API_KEY
  const envToken = process.env.DEEPSEEK_PLATFORM_TOKEN
  cfg.apiKeySource = typeof envKey === 'string' && envKey.trim() ? 'env' : (cfg.apiKey ? 'config' : '')
  if (cfg.apiKeySource === 'env') cfg.apiKey = envKey.trim()
  if (typeof envToken === 'string' && envToken.trim()) {
    cfg.platformToken = envToken.trim()
    cfg.platformTokenSource = 'env'
  } else {
    cfg.platformTokenSource = cfg.platformToken ? 'config' : ''
  }
  return cfg
}

function save(patch) {
  const cur = readFile() || { ...DEFAULTS }
  const next = sanitize({ ...cur, ...(patch || {}) })
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    const tmp = CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, CONFIG_FILE)
    return next
  } catch (err) {
    return null
  }
}

module.exports = { DEFAULTS, CONFIG_DIR, CONFIG_FILE, USAGE_FILE, sanitize, readFile: readFile, getEffective, save }
