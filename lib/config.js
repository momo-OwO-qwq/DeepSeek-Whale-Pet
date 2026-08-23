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
// 应用根目录（lib/config.js → 上一级），用于校验内置素材（如预警图）是否存在
const APP_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  apiKey: '',
  platformToken: '',
  scale: 1.0,               // 0.6 - 2.5（默认 1.0）
  soundSet: 'duck',         // duck（音效1）| fx1（音效2）
  volume: 1.0,              // 0 - 1（默认 100%）
  usageMode: 'ledger',      // ledger | token
  peakMode: 'default',      // default | liangwen | qiangqiang
  peakText: true,           // 气泡里显示峰谷时段提示
  bubbleOn: true,
  bubbleInterval: 120,      // 每隔 N 秒自动弹出一次随机台词气泡（0 = 关闭，默认 120 秒）
  idleFade: true,           // 闲置半透明（开关）
  idleOpacity: 0.6,         // 闲置时的不透明度（0.2 - 1.0，可拖动调节）
  refreshInterval: 60,      // 秒
  lowBalanceThreshold: 5,   // 元（默认 5）
  alertImage: false,        // 达到预警额度时切换鲸鱼图片（默认关闭）
  // 预警图默认取 assets/DSniang03.png；若素材不存在则视为「无默认预警图」（alertImgPath 置空）
  alertImgPath: 'assets/DSniang03.png',
  mainImgPath: 'assets/DSniang1.png',   // 主图（默认显示图，可上传替换）
  theme: 'system',          // system | light | dark（设置面板深色模式）
  bubbleTextOk: 'DeepSeek 余额', // 余额充足时气泡第一行文字（限 20 字符）
  bubbleTextLow: '余额预警',   // 预警状态气泡第一行文字（限 20 字符）
  textColorOk: '',          // 余额充足文案颜色（'' = 默认 #536ba9；否则 #rrggbb）
  textColorLow: '',         // 预警文案颜色
  peakTextOff: '',          // 自定义空闲时段文案（'' = 用内置/峰谷模式，限 12 字符）
  peakTextOn: '',           // 自定义高峰时段文案
  pressSound: '',           // 自定义按压音效路径（'' = 用当前音效集）
  releaseSound: '',         // 自定义松手音效路径
  autostart: false,
  posX: null,               // 上次窗口位置（屏幕坐标）
  posY: null,
  posH: 'right',            // left | right | null（已弃用，兼容旧配置保留）
  posV: 'bottom',           // top | bottom | null（已弃用，兼容旧配置保留）
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
  if (d.bubbleInterval !== undefined) cfg.bubbleInterval = Math.round(num(d.bubbleInterval, 0, 86400, DEFAULTS.bubbleInterval))
  if (typeof d.idleFade === 'boolean') cfg.idleFade = d.idleFade
  if (d.idleOpacity !== undefined) cfg.idleOpacity = Math.round(num(d.idleOpacity, 0.2, 1, DEFAULTS.idleOpacity) * 100) / 100
  if (d.refreshInterval !== undefined) cfg.refreshInterval = Math.round(num(d.refreshInterval, 5, 3600, DEFAULTS.refreshInterval))
  if (d.lowBalanceThreshold !== undefined) cfg.lowBalanceThreshold = Math.round(num(d.lowBalanceThreshold, 0, 1e9, DEFAULTS.lowBalanceThreshold) * 100) / 100
  if (typeof d.alertImage === 'boolean') cfg.alertImage = d.alertImage
  if (typeof d.alertImgPath === 'string' && d.alertImgPath.trim()) cfg.alertImgPath = d.alertImgPath.trim()
  if (typeof d.mainImgPath === 'string' && d.mainImgPath.trim()) cfg.mainImgPath = d.mainImgPath.trim()
  if (['system', 'light', 'dark'].includes(d.theme)) cfg.theme = d.theme
  if (typeof d.bubbleTextOk === 'string') cfg.bubbleTextOk = d.bubbleTextOk.trim().slice(0, 20) || DEFAULTS.bubbleTextOk
  if (typeof d.bubbleTextLow === 'string') cfg.bubbleTextLow = d.bubbleTextLow.trim().slice(0, 20) || DEFAULTS.bubbleTextLow
  if (typeof d.textColorOk === 'string') cfg.textColorOk = /^#[0-9a-fA-F]{6}$/.test(d.textColorOk.trim()) ? d.textColorOk.trim() : ''
  if (typeof d.textColorLow === 'string') cfg.textColorLow = /^#[0-9a-fA-F]{6}$/.test(d.textColorLow.trim()) ? d.textColorLow.trim() : ''
  if (typeof d.peakTextOff === 'string') cfg.peakTextOff = d.peakTextOff.trim().slice(0, 12)
  if (typeof d.peakTextOn === 'string') cfg.peakTextOn = d.peakTextOn.trim().slice(0, 12)
  if (typeof d.pressSound === 'string') cfg.pressSound = d.pressSound.trim()
  if (typeof d.releaseSound === 'string') cfg.releaseSound = d.releaseSound.trim()
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
  // 内置素材默认路径（assets/*）不存在 → 视为未提供（如无 DSniang03.png 则无默认预警图）
  if (typeof cfg.alertImgPath === 'string' && cfg.alertImgPath) {
    const p = cfg.alertImgPath
    const isBundled = /^assets\//.test(p)
    if (isBundled && !fs.existsSync(path.resolve(APP_ROOT, p))) cfg.alertImgPath = ''
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
