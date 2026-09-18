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
const audio = require('./audio')

// 平台自适应配置目录：Windows 用 %APPDATA%/whale-pet，macOS 用
// ~/Library/Application Support/whale-pet，其余 ~/.config/whale-pet；
// 可用 WHALE_PET_HOME 重定向（开发/CI 用）。
function defaultConfigDir() {
  if (process.env.WHALE_PET_HOME) return process.env.WHALE_PET_HOME
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'whale-pet')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'whale-pet')
  }
  return path.join(os.homedir(), '.config', 'whale-pet')
}
const CONFIG_DIR = defaultConfigDir()
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json')
// ---- v0.3.5 新功能的资源目录（与上游 $DSH_HOME/whale-* 同构，落在本应用配置目录下）----
const BUBBLE_FILE = path.join(CONFIG_DIR, 'bubble.json')          // 自定义泡泡配置
const AUDIO_DIR = path.join(CONFIG_DIR, 'audio')                  // 音频片段 + audio.json
const AUDIO_FILE = path.join(AUDIO_DIR, 'audio.json')
const ROLES_DIR = path.join(CONFIG_DIR, 'roles')                  // 自定义角色 + roles.json
const ROLES_FILE = path.join(ROLES_DIR, 'roles.json')
const BUBBLE_IMG_DIR = path.join(CONFIG_DIR, 'bubble-imgs')       // 泡泡图库 + bubble-imgs.json
const BUBBLE_IMG_FILE = path.join(BUBBLE_IMG_DIR, 'bubble-imgs.json')
// 应用根目录（lib/config.js → 上一级），用于校验内置素材（如预警表情）是否存在
const APP_ROOT = path.resolve(__dirname, '..')

// 配置结构版本。每次「DEFAULTS 增删字段」时 +1，升级时会自动把缺的字段补进
// 用户已有的 config.json，同时**完整保留用户数据**（API Key、位置、自定义文案…）。
//
// 为什么需要它：readFile() 会补默认值到内存，但磁盘文件一直停在旧结构 ——
// 用户升级后打开 config.json 看不到新字段，也不知道有哪些新配置项。
const CONFIG_VERSION = 2

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
  alertImage: false,        // 达到预警额度时切换鲸鱼图片（默认关闭，可在「形象」页开启）
  // 预警表情：余额低于阈值时切到这张「委屈」脸（随包素材，610×610 透明 cut-out）
  alertImgPath: 'assets/DSniang-sad.png',
  mainImgPath: 'assets/DSniang1.png',   // 主图（默认显示图，可上传替换）
  // 余额快速减少播报时切换的「开心」表情（随包素材）。空 = 不切换，保持主图。
  dropImgPath: 'assets/DSniang-happy.png',
  dropImgHoldMs: 2600,      // 播报表情保持时长（毫秒）；0 = 不自动恢复
  dropImage: true,          // 余额快速减少时切换表情（开关）
  theme: 'system',          // system | light | dark（设置面板深色模式）
  bubbleTextOk: 'DeepSeek 余额', // 余额充足时气泡第一行文字（限 20 字符）
  bubbleTextLow: '余额预警',   // 预警状态气泡第一行文字（限 20 字符）
  textColorOk: '',          // 余额充足文案颜色（'' = 默认 #536ba9；否则 #rrggbb）
  textColorLow: '',         // 预警文案颜色
  peakTextOff: '',          // 自定义空闲时段文案（'' = 用内置/峰谷模式，限 12 字符）
  peakTextOn: '',           // 自定义高峰时段文案
  pressSound: '',           // 自定义按压音效路径（'' = 用当前音效集）
  releaseSound: '',         // 自定义松手音效路径
  // ---- v0.3.5 新功能（本次移植）----
  // 隐藏菜单按钮：隐藏后右键鲸鱼唤出（上游 menuBtnHide）
  menuBtnHide: false,
  // 任务结束音（上游 usageSettingsDefaults().taskEnd）：默认关闭，默认选中内置经验球
  taskEnd: { on: false, sel: 'frag:exp_orb', pins: [] },
  // 当前音效组 id（内置 duck/fx1，或用户自定义组）。soundSet 保留为旧字段兼容。
  audioGroup: 'duck',
  // 自定义角色（上游 localStorage['dshw-role']）：'default' 或角色 id
  roleId: 'default',
  // 点击角色推进泡泡队列（上游 bubbleCfg.tapAdvance 的镜像，便于渲染层直读）
  bubbleTapAdvance: false,
  autostart: false,
  posX: null,               // 上次窗口位置（屏幕坐标）
  posY: null,
  posH: 'right',            // left | right | null（已弃用，兼容旧配置保留）
  posV: 'bottom',           // top | bottom | null（已弃用，兼容旧配置保留）
  // 配置结构版本：由 migrate() 写入。仅用于识别「需要补齐字段」的旧文件，
  // 与 package.json 的应用版本解耦（改应用版本不必动它，只有配置结构变化才 +1）。
  configVersion: CONFIG_VERSION,
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
  // 三张形象图路径：空串是**合法值**（= 未提供该形象），不能被「非空才写入」
  // 的写法吃掉 —— 那会让用户显式清空后又被默认值顶回来。
  if (typeof d.alertImgPath === 'string') cfg.alertImgPath = d.alertImgPath.trim()
  if (typeof d.mainImgPath === 'string') cfg.mainImgPath = d.mainImgPath.trim()
  // 快速减少播报表情：空串是合法值（= 不切换表情），因此不能用「非空才写入」的写法
  if (typeof d.dropImgPath === 'string') cfg.dropImgPath = d.dropImgPath.trim()
  if (d.dropImgHoldMs !== undefined) cfg.dropImgHoldMs = Math.round(num(d.dropImgHoldMs, 0, 60000, DEFAULTS.dropImgHoldMs))
  if (typeof d.dropImage === 'boolean') cfg.dropImage = d.dropImage
  if (['system', 'light', 'dark'].includes(d.theme)) cfg.theme = d.theme
  if (typeof d.bubbleTextOk === 'string') cfg.bubbleTextOk = d.bubbleTextOk.trim().slice(0, 20) || DEFAULTS.bubbleTextOk
  if (typeof d.bubbleTextLow === 'string') cfg.bubbleTextLow = d.bubbleTextLow.trim().slice(0, 20) || DEFAULTS.bubbleTextLow
  if (typeof d.textColorOk === 'string') cfg.textColorOk = /^#[0-9a-fA-F]{6}$/.test(d.textColorOk.trim()) ? d.textColorOk.trim() : ''
  if (typeof d.textColorLow === 'string') cfg.textColorLow = /^#[0-9a-fA-F]{6}$/.test(d.textColorLow.trim()) ? d.textColorLow.trim() : ''
  if (typeof d.peakTextOff === 'string') cfg.peakTextOff = d.peakTextOff.trim().slice(0, 12)
  if (typeof d.peakTextOn === 'string') cfg.peakTextOn = d.peakTextOn.trim().slice(0, 12)
  if (typeof d.pressSound === 'string') cfg.pressSound = d.pressSound.trim()
  if (typeof d.releaseSound === 'string') cfg.releaseSound = d.releaseSound.trim()
  // ---- v0.3.5 新字段消毒 ----
  if (typeof d.menuBtnHide === 'boolean') cfg.menuBtnHide = d.menuBtnHide
  // 任务结束音
  if (d.taskEnd && typeof d.taskEnd === 'object') cfg.taskEnd = audio.sanitizeTaskEnd(d.taskEnd)
  // 音效组 id：内置或自定义组 id（自定义组合法性由 lib/audio.js 校验，这里只做形态约束）
  if (typeof d.audioGroup === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.audioGroup)) cfg.audioGroup = d.audioGroup
  if (typeof d.roleId === 'string' && /^(default|[A-Za-z0-9_-]{1,64})$/.test(d.roleId)) cfg.roleId = d.roleId
  if (typeof d.bubbleTapAdvance === 'boolean') cfg.bubbleTapAdvance = d.bubbleTapAdvance
  if (typeof d.autostart === 'boolean') cfg.autostart = d.autostart
  if (d.posX !== null && d.posX !== undefined && isFinite(Number(d.posX))) cfg.posX = Math.round(Number(d.posX))
  if (d.posY !== null && d.posY !== undefined && isFinite(Number(d.posY))) cfg.posY = Math.round(Number(d.posY))
  if (typeof d.posH === 'string') cfg.posH = d.posH === 'left' ? 'left' : (d.posH === 'right' ? 'right' : null)
  if (typeof d.posV === 'string') cfg.posV = d.posV === 'top' ? 'top' : 'bottom'
  // 配置结构版本（非法值视为 0 = 需要迁移）
  cfg.configVersion = (d.configVersion !== undefined && isFinite(Number(d.configVersion)))
    ? Math.max(0, Math.round(Number(d.configVersion)))
    : 0
  return cfg
}

// ---------------------------------------------------------------- 配置迁移
// 升级时把新版 DEFAULTS 里「用户文件缺失的字段」补进去，**不覆盖任何已有值**。
//
// 安全原则（顺序很重要）：
//   1. 先读原始 JSON（不做 sanitize）→ 用它判断「哪些键用户真的没写过」
//   2. 只对**缺失的键**填默认值；已存在的键原样保留（哪怕值是空串/false/0）
//   3. 迁移前先备份一份 config.json.bak-<旧版本>（仅在首次迁移时写）
//   4. 写失败不影响使用（内存里 readFile 仍会补全，只是磁盘没升级）
//
// 返回 { changed, added, backedUp, version }，供启动日志与测试断言。
function migrate() {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    return { changed: false, added: [], backedUp: false, version: CONFIG_VERSION, missingFile: true }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { changed: false, added: [], backedUp: false, version: CONFIG_VERSION, invalid: true }
  }
  const fromVersion = isFinite(Number(raw.configVersion)) ? Number(raw.configVersion) : 0
  // 只补键、不动值：用原始键集合判断缺失
  const added = []
  const next = { ...raw }
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      next[key] = DEFAULTS[key]
      added.push(key)
    }
  }
  const nextVersion = CONFIG_VERSION
  const versionBumped = fromVersion !== nextVersion
  if (!added.length && !versionBumped) {
    return { changed: false, added: [], backedUp: false, version: nextVersion }
  }
  next.configVersion = nextVersion
  // 首次迁移前备份（带旧版本号，便于用户找回）
  let backedUp = false
  if (fromVersion < nextVersion) {
    try {
      const bak = CONFIG_FILE + '.bak-v' + fromVersion
      if (!fs.existsSync(bak)) {
        fs.copyFileSync(CONFIG_FILE, bak)
        backedUp = true
      }
    } catch (err) { /* 备份失败不阻塞迁移 */ }
  }
  // 迁移后走 sanitize 落盘（保证写出去的一定是合法配置），但值取自 next
  const finalCfg = sanitize(next)
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    const tmp = CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(finalCfg, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, CONFIG_FILE)
  } catch (err) {
    return { changed: false, added: [], backedUp, version: nextVersion, writeError: String(err && err.message) }
  }
  return { changed: true, added, backedUp, version: nextVersion, fromVersion }
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
  // 内置素材默认路径（assets/*）不存在 → 视为未提供，避免渲染层加载到不存在的图。
  // 三张形象图统一走这条规则（预警表情 / 播报表情 / 主形象）。
  const bundledMissing = (p) => typeof p === 'string' && /^assets\//.test(p) && !fs.existsSync(path.resolve(APP_ROOT, p))
  if (bundledMissing(cfg.alertImgPath)) cfg.alertImgPath = ''
  if (bundledMissing(cfg.dropImgPath)) cfg.dropImgPath = ''
  if (bundledMissing(cfg.mainImgPath)) cfg.mainImgPath = ''
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

module.exports = {
  DEFAULTS, CONFIG_VERSION, CONFIG_DIR, CONFIG_FILE, USAGE_FILE, BUBBLE_FILE,
  AUDIO_DIR, AUDIO_FILE, ROLES_DIR, ROLES_FILE, BUBBLE_IMG_DIR, BUBBLE_IMG_FILE,
  APP_ROOT, sanitize, readFile: readFile, getEffective, save, migrate,
}
