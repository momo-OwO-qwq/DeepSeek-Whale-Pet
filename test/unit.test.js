'use strict'
// ---------------------------------------------------------------------------
// 核心逻辑单元测试（纯 Node，不依赖 Electron）
//   WHALE_PET_HOME 必须在 require 任何 lib 模块之前设置（config 在加载时固化目录）
//   DEEPSEEK_API_KEY 环境变量会覆盖 config —— 测试里注意清空
// ---------------------------------------------------------------------------
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pet-test-'))
process.env.WHALE_PET_HOME = TEST_HOME
delete process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_PLATFORM_TOKEN

const bal = require('../lib/balance')
const config = require('../lib/config')
const ledger = require('../lib/ledger')
const lines = require('../lib/lines')

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✔ ' + name)
  } catch (err) {
    console.error('  ✘ ' + name)
    console.error('    ' + (err && err.message ? err.message : err))
    process.exitCode = 1
  }
}

// ---------- 峰谷时间 ----------
test('isPeakTime: 北京时间边界', () => {
  // 2026-08-17 是周一；T+8h 得到北京时间
  const bj = (h, m, s) => Math.floor(new Date(Date.UTC(2026, 7, 17, h - 8, m, s)).getTime() / 1000)
  assert.strictEqual(bal.isPeakTime(bj(8, 30, 0)), false, '08:30 空闲')
  assert.strictEqual(bal.isPeakTime(bj(9, 0, 0)), true, '09:00 高峰')
  assert.strictEqual(bal.isPeakTime(bj(11, 59, 0)), true, '11:59 高峰')
  assert.strictEqual(bal.isPeakTime(bj(12, 0, 0)), false, '12:00 空闲（12:00 不含）')
  assert.strictEqual(bal.isPeakTime(bj(13, 59, 0)), false, '13:59 空闲')
  assert.strictEqual(bal.isPeakTime(bj(14, 0, 0)), true, '14:00 高峰')
  assert.strictEqual(bal.isPeakTime(bj(17, 59, 0)), true, '17:59 高峰')
  assert.strictEqual(bal.isPeakTime(bj(18, 0, 0)), false, '18:00 空闲（18:00 不含）')
  assert.strictEqual(bal.isPeakTime(NaN), false)
  assert.strictEqual(bal.isPeakTime(null), false)
})

// ---------- 定价表 ----------
test('priceFor: 模型匹配与默认回落', () => {
  assert.strictEqual(bal.priceFor('deepseek-v4-flash-vision-exp'), bal.BASE_PRICE)
  assert.strictEqual(bal.priceFor('deepseek-v4-flash'), bal.BASE_PRICE)
  assert.strictEqual(bal.priceFor('deepseek-v4-pro'), bal.PRO_PRICE)
  assert.strictEqual(bal.priceFor('deepseek-chat'), bal.BASE_PRICE)
  assert.strictEqual(bal.priceFor('unknown-model-xyz'), bal.BASE_PRICE)
  assert.strictEqual(bal.priceFor(''), bal.BASE_PRICE)
})

// ---------- balance_infos 选取 ----------
test('pickBalanceInfo: 优先级 CNY>0 → 任意非零 → CNY → 第一项', () => {
  const infos = [
    { currency: 'USD', total_balance: '3.5' },
    { currency: 'CNY', total_balance: '0' },
    { currency: 'CNY', total_balance: '12.34' },
  ]
  assert.strictEqual(bal.pickBalanceInfo(infos).currency, 'CNY')
  assert.strictEqual(bal.pickBalanceInfo(infos).total_balance, '12.34')

  // 无正数 CNY → 取任意非零
  const infos2 = [
    { currency: 'CNY', total_balance: '0' },
    { currency: 'USD', total_balance: '99' },
  ]
  assert.strictEqual(bal.pickBalanceInfo(infos2).currency, 'USD')

  // 全为零 → 退回 CNY 项
  const infos3 = [
    { currency: 'USD', total_balance: '0' },
    { currency: 'CNY', total_balance: '0' },
  ]
  assert.strictEqual(bal.pickBalanceInfo(infos3).currency, 'CNY')

  // 没有 CNY → 第一项
  const infos4 = [
    { currency: 'USD', total_balance: '0' },
    { currency: 'EUR', total_balance: '0' },
  ]
  assert.strictEqual(bal.pickBalanceInfo(infos4).currency, 'USD')
  assert.strictEqual(bal.pickBalanceInfo([]), null)
})

// ---------- 平台用量换算 ----------
test('computeTodayUsage: 峰谷定价换算', () => {
  const peak = Math.floor(Date.UTC(2026, 7, 17, 2, 0, 0) / 1000) // 北京时间 10:00 → 高峰
  const off = Math.floor(Date.UTC(2026, 7, 17, 0, 0, 0) / 1000) // 北京时间 08:00 → 空闲
  const mk = (time, hit, miss, out) => ({
    model: 'deepseek-v4-flash',
    buckets: [{ time, usage: { PROMPT_CACHE_HIT_TOKEN: hit, PROMPT_CACHE_MISS_TOKEN: miss, RESPONSE_TOKEN: out } }],
  })
  // 高峰 1M+1M+1M：0.10 + 3.00 + 9.00 = 12.10
  let u = bal.computeTodayUsage({ data: { biz_data: { series: [mk(peak, 1e6, 1e6, 1e6)] } } })
  assert.ok(Math.abs(u.amount - 12.1) < 1e-9, 'peak cost 12.1, got ' + u.amount)
  // 空闲 1M+1M+1M：0.05 + 1.50 + 4.50 = 6.05
  u = bal.computeTodayUsage({ data: { biz_data: { series: [mk(off, 1e6, 1e6, 1e6)] } } })
  assert.ok(Math.abs(u.amount - 6.05) < 1e-9, 'off-peak cost 6.05, got ' + u.amount)
  // pro 模型 3 倍：空闲 1M×3 → 0.15 + 4.5 + 13.5 = 18.15
  const mkPro = (time, hit, miss, out) => ({
    model: 'deepseek-v4-pro',
    buckets: [{ time, usage: { PROMPT_CACHE_HIT_TOKEN: hit, PROMPT_CACHE_MISS_TOKEN: miss, RESPONSE_TOKEN: out } }],
  })
  u = bal.computeTodayUsage({ data: { series: [mkPro(off, 1e6, 1e6, 1e6)] } })
  assert.ok(Math.abs(u.amount - 18.15) < 1e-9, 'pro off-peak 18.15, got ' + u.amount)
  // 空数据
  assert.strictEqual(bal.computeTodayUsage({}), null)
  assert.strictEqual(bal.computeTodayUsage({ data: { biz_data: { series: [] } } }), null)
  // 全 0 token 不算 found
  u = bal.computeTodayUsage({ data: { biz_data: { series: [mk(peak, 0, 0, 0)] } } })
  assert.strictEqual(u, null)
})

// ---------- fetchBalance（mock fetch） ----------
test('fetchBalance: 成功 / 401 不重试 / 500 重试 / 超时', async () => {
  const orig = global.fetch
  try {
    // 成功
    global.fetch = async (url, opts) => {
      assert.ok(url.includes('api.deepseek.com/user/balance'))
      assert.strictEqual(opts.headers.Authorization, 'Bearer sk-test')
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '88.88' }] }) }
    }
    let r = await bal.fetchBalance('sk-test')
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.totalBalance, 88.88)
    assert.strictEqual(r.currency, 'CNY')

    // 401：4xx 不重试（只调用 1 次）
    let calls = 0
    global.fetch = async () => { calls++; return { ok: false, status: 401 } }
    r = await bal.fetchBalance('sk-bad')
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.transient, false)
    assert.strictEqual(calls, 1)
    assert.ok(r.error.includes('HTTP 401'))

    // 500 后成功：重试一次
    calls = 0
    global.fetch = async () => {
      calls++
      if (calls === 1) return { ok: false, status: 503 }
      return { ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '10' }] }) }
    }
    r = await bal.fetchBalance('sk-test')
    assert.strictEqual(r.ok, true)
    assert.strictEqual(calls, 2)

    // 网络异常重试后仍失败 → transient true
    global.fetch = async () => { throw new Error('ETIMEDOUT') }
    r = await bal.fetchBalance('sk-test')
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.transient, true)
    assert.ok(r.error.includes('ETIMEDOUT'))
  } finally {
    global.fetch = orig
  }
})

// ---------- 小鲸鱼记账 ----------
test('ledger: 余额下降累计 / 充值不扣减 / 跨天归档', () => {
  // 清理
  for (const f of fs.readdirSync(TEST_HOME)) fs.rmSync(path.join(TEST_HOME, f), { recursive: true, force: true })

  // 同一天：100 → 90（+10）→ 95（充值，不加）→ 90（+5）
  ledger.recordBalance(100)
  let led = ledger.recordBalance(90)
  assert.strictEqual(led.todayUsage, 10)
  led = ledger.recordBalance(95)
  assert.strictEqual(led.todayUsage, 10, '余额上升不扣减')
  led = ledger.recordBalance(90)
  assert.strictEqual(led.todayUsage, 15)
  assert.strictEqual(led.lastBalance, 90)

  // 跨天：伪造昨天的账本再观测
  const today = ledger.todayKey()
  const yesterday = '2000-01-01'
  fs.writeFileSync(ledger.USAGE_FILE, JSON.stringify({ date: yesterday, lastBalance: 50, todayUsage: 7, history: {} }))
  led = ledger.recordBalance(40)
  assert.strictEqual(led.date, today)
  assert.strictEqual(led.todayUsage, 0)
  assert.strictEqual(led.history[yesterday], 7)
  assert.strictEqual(led.lastBalance, 40)
})

// ---------- 配置 ----------
test('config: 消毒 / 原子保存 / 环境变量覆盖', () => {
  // 越界值归一
  const s = config.sanitize({ scale: 99, volume: -3, refreshInterval: 1, soundSet: 'nope', usageMode: 'x', peakMode: 'hack', posH: 'auto' })
  assert.strictEqual(s.scale, 2.5)
  assert.strictEqual(s.volume, 0)
  assert.strictEqual(s.refreshInterval, 5)
  assert.strictEqual(s.soundSet, 'duck')
  assert.strictEqual(s.usageMode, 'ledger')
  assert.strictEqual(s.peakMode, 'default')
  assert.strictEqual(s.posH, null)

  // 预警换图：默认关闭；开启后路径可自定义
  const sa = config.sanitize({})
  assert.strictEqual(sa.alertImage, false, '预警换图默认关闭')
  assert.strictEqual(sa.alertImgPath, 'assets/DSniang02.png')
  assert.strictEqual(sa.mainImgPath, 'assets/DSniang1.png', '主图默认内置素材')
  assert.strictEqual(sa.theme, 'system', '主题默认跟随系统')
  const sa2 = config.sanitize({ alertImage: true, alertImgPath: 'assets/warn.png' })
  assert.strictEqual(sa2.alertImage, true)
  assert.strictEqual(sa2.alertImgPath, 'assets/warn.png')
  const sa3 = config.sanitize({ alertImage: true, alertImgPath: '   ' })
  assert.strictEqual(sa3.alertImgPath, 'assets/DSniang02.png', '空路径回退默认')

  // 主图/主题/气泡文案
  const s4 = config.sanitize({ mainImgPath: '/tmp/my-whale.png', theme: 'dark', bubbleTextOk: '  余额还够用  ', bubbleTextLow: '快没余额了！！！！！超过了二十个字符限制' })
  assert.strictEqual(s4.mainImgPath, '/tmp/my-whale.png')
  assert.strictEqual(s4.theme, 'dark')
  assert.strictEqual(s4.bubbleTextOk, '余额还够用', 'trim')
  assert.ok(s4.bubbleTextLow.length <= 20, '文案限 20 字符, got ' + s4.bubbleTextLow.length)
  const s5 = config.sanitize({ theme: 'rainbow', bubbleTextOk: '   ' })
  assert.strictEqual(s5.theme, 'system', '非法主题回退')
  assert.strictEqual(s5.bubbleTextOk, 'DeepSeek 余额', '空白文案回退默认')

  // 文案颜色 / 峰谷自定义 / 自定义音效
  const s6 = config.sanitize({ textColorOk: '#ff8800', textColorLow: 'red', peakTextOff: '  谷  ', peakTextOn: '峰峰峰峰峰峰峰峰峰峰峰峰峰', pressSound: '/tmp/a.mp3', releaseSound: '  ' })
  assert.strictEqual(s6.textColorOk, '#ff8800')
  assert.strictEqual(s6.textColorLow, '', '非法颜色回退空')
  assert.strictEqual(s6.peakTextOff, '谷', 'trim')
  assert.ok(s6.peakTextOn.length <= 12, '峰谷文案限 12 字符, got ' + s6.peakTextOn.length)
  assert.strictEqual(s6.pressSound, '/tmp/a.mp3')
  assert.strictEqual(s6.releaseSound, '', '空白音效路径回退空')
  assert.strictEqual(config.sanitize({}).pressSound, '', '自定义音效默认关闭')

  // 保存 + 读回
  const saved = config.save({ apiKey: 'sk-123', scale: 1.7, volume: 0.5 })
  assert.strictEqual(saved.apiKey, 'sk-123')
  let eff = config.getEffective()
  assert.strictEqual(eff.apiKey, 'sk-123')
  assert.strictEqual(eff.apiKeySource, 'config')
  assert.strictEqual(eff.scale, 1.7)

  // 环境变量覆盖（config 值仍在文件中，但读取时被优先）
  process.env.DEEPSEEK_API_KEY = 'sk-env'
  eff = config.getEffective()
  assert.strictEqual(eff.apiKey, 'sk-env')
  assert.strictEqual(eff.apiKeySource, 'env')
  delete process.env.DEEPSEEK_API_KEY
  eff = config.getEffective()
  assert.strictEqual(eff.apiKey, 'sk-123')

  // 配置文件权限 0600（含密钥）
  const mode = fs.statSync(config.CONFIG_FILE).mode & 0o777
  assert.strictEqual(mode, 0o600)
})

// ---------- 随机台词池（lines.json） ----------
test('lines: 首次读取自动生成默认池 / 消毒 / 空池回退', () => {
  fs.rmSync(lines.LINES_FILE, { force: true })
  const pool = lines.readPool()
  assert.ok(pool.groups.length > 0, '默认池非空')
  assert.ok(fs.existsSync(lines.LINES_FILE), '首次读取自动生成 lines.json')
  const raw = JSON.parse(fs.readFileSync(lines.LINES_FILE, 'utf8'))
  assert.ok(raw.groups.length > 0, '文件内含全部默认组')

  // 消毒：超长 text 截断、非法 style 回退 A、weight<=0 丢弃、lines 空丢弃
  const s = lines.sanitizePool({
    groups: [
      { weight: 5, lines: [{ text: 'x'.repeat(99), style: 'z' }] },
      { weight: 0, type: 'gif' },
      { weight: 3, type: 'balance' },
      { weight: 4, lines: [] },
    ],
  })
  assert.strictEqual(s.groups.length, 2)
  assert.strictEqual(s.groups[0].lines[0].text.length, 40)
  assert.strictEqual(s.groups[0].lines[0].style, 'A')
  assert.strictEqual(s.groups[1].type, 'balance')
  // 空池回退默认
  assert.ok(lines.sanitizePool({ groups: [] }).groups.length > 0)
  assert.ok(lines.sanitizePool(null).groups.length > 0)
})

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''))
