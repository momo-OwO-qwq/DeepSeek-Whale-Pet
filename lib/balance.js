'use strict'
// ---------------------------------------------------------------------------
// 余额 / 用量核心：与原版 DSH 插件 lib/index.js 宿主侧逻辑 1:1 移植
// - 余额拉取：GET https://api.deepseek.com/user/balance
//   · balance_infos 选取规则（优先级）：CNY 且 >0 → 任意非零 → CNY → 第一项
//   · 重试：网络错误/超时/5xx 重试 1 次（间隔 500ms）；4xx 不重试
//   · 缓存：25 秒内存 TTL + 进行中请求去重（in-flight 复用）
//   · 瞬时失败（非 4xx）时回退缓存中的最近余额（stale 标记）
// - 今日已用双模式：
//   · ledger：小鲸鱼记账（余额差值，见 lib/ledger.js）
//   · token：平台用量接口 + 峰谷定价换算（与原版完全一致的定价表）
// ---------------------------------------------------------------------------
const ledger = require('./ledger')

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL_BASE = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
const BALANCE_TTL_MS = 25000
const FETCH_TIMEOUT_MS = 20000

// 峰谷时段：每日 9:00–12:00 与 14:00–18:00（北京时间 UTC+8）
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
// DeepSeek CNY 单价（每百万 token）：[空闲时段价, 高峰时段价]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
// deepseek-v4-pro 为 flash 的 3 倍价（官方 2026-08-17 生效）；vision-exp 与 flash 同价
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

// bucket time 是 Unix 秒；换算北京时间判断峰谷。
// 周末（周六、周日）全天不再区分峰谷，统一按低谷（off-peak）计费。
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const d = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000)
  const day = d.getUTCDay() // 0=周日, 6=周六
  if (day === 0 || day === 6) return false // 周末全天低谷
  const hour = d.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === 'CNY') ||
    infos[0]
  )
}

async function fetchBalance(apiKey) {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500) break
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    let data
    try {
      data = await res.json()
    } catch (err) {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    if (!info || info.total_balance === undefined) {
      return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    }
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }
  const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
  return {
    ok: false,
    code: 'HTTP',
    transient,
    error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
  }
}

function stripBearer(v) {
  return String(v || '').replace(/^Bearer\s+/i, '')
}

async function fetchUsage(platformToken) {
  try {
    const now = new Date()
    const tz = -now.getTimezoneOffset() * 60
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    const end = start + 86400
    const url = USAGE_URL_BASE + '?start=' + start + '&end=' + end + '&tz=' + tz
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + stripBearer(platformToken) },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { error: 'http ' + res.status }
    const data = await res.json()
    const u = computeTodayUsage(data)
    if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens }
    return { error: 'no usage' }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
}

function computeTodayUsage(data) {
  // data.data.biz_data.series[]: [{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}]
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d.series) ? d.series : null
  if (!series || series.length === 0) return null
  let cost = 0
  let tokens = 0
  let found = false
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const p = priceFor(s.model)
    const buckets = Array.isArray(s.buckets) ? s.buckets : []
    for (const b of buckets) {
      const u = b && b.usage
      if (!u || typeof u !== 'object') continue
      const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
      const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
      const out = Number(u.RESPONSE_TOKEN) || 0
      if (hit + miss + out === 0) continue
      found = true
      tokens += hit + miss + out
      const pi = isPeakTime(b.time) ? 1 : 0
      cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
    }
  }
  return found ? { amount: cost, tokens } : null
}

// 余额服务：TTL 缓存 + in-flight 去重 + 记账观测 + 双模式今日已用
class BalanceService {
  constructor() {
    this.cache = null // { at, payload }
    this.inFlight = null
  }

  invalidate() {
    this.cache = null
  }

  getSnapshot(cfg) {
    const now = Date.now()
    if (this.cache && now - this.cache.at < BALANCE_TTL_MS) {
      return Promise.resolve(this.cache.payload)
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.compute(cfg)
      .then((payload) => {
        if (payload.ok) {
          this.cache = { at: Date.now(), payload }
        } else if (payload.transient && this.cache) {
          return { ...this.cache.payload, stale: true, error: payload.error }
        }
        return payload
      })
      .catch((err) => ({ ok: false, code: 'ERROR', error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200) }))
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  async compute(cfg) {
    if (!cfg.apiKey) {
      return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY（菜单 → API Key）' }
    }
    const payload = await fetchBalance(cfg.apiKey)
    if (!payload.ok) return payload
    // 无论哪种模式，都先把余额观测记入账本（自动累积「小鲸鱼记账」数据）
    const led = ledger.recordBalance(Number(payload.totalBalance))
    const full = { ...payload }
    full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
    if (cfg.usageMode === 'token') {
      if (cfg.platformToken) {
        const u = await fetchUsage(cfg.platformToken)
        if (u && u.amount !== undefined) {
          full.todayUsage = u.amount
          full.usageMode = 'token'
          return full
        }
      }
      // 无令牌或令牌失败：回落记账模式
      full.todayUsage = led.todayUsage
      full.usageMode = 'ledger'
      return full
    }
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    return full
  }
}

module.exports = {
  PEAK_HOURS,
  BASE_PRICE,
  PRO_PRICE,
  PRICING,
  priceFor,
  isPeakTime,
  pickBalanceInfo,
  fetchBalance,
  fetchUsage,
  computeTodayUsage,
  BalanceService,
  BALANCE_URL,
  BALANCE_TTL_MS,
}
