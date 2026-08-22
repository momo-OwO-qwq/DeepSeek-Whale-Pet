'use strict'
// ---------------------------------------------------------------------------
// 小鲸鱼记账（默认模式）：每次观测到余额后，用余额下降的差值累计当天用量。
// 持久化到 ~/.config/whale-pet/usage.json；跨天自动归零并归档历史（保留 30 天）。
// 与原版（DSH 插件 lib/index.js recordLedgerUsage）语义完全一致。
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const config = require('./config')

const USAGE_FILE = config.USAGE_FILE

function todayKey(now) {
  const d = now || new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') {
      return {
        date: parsed.date,
        lastBalance: typeof parsed.lastBalance === 'number' ? parsed.lastBalance : null,
        todayUsage: typeof parsed.todayUsage === 'number' ? parsed.todayUsage : 0,
        history: parsed.history && typeof parsed.history === 'object' ? parsed.history : {},
      }
    }
  } catch (err) {}
  return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
}

function writeLedger(led) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true, mode: 0o700 })
    const tmp = USAGE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(led, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, USAGE_FILE)
    return true
  } catch (err) {
    return false
  }
}

// 观测一次余额 → 返回（可能已更新）的账本
function recordBalance(currentBalance, now) {
  const t = todayKey(now)
  let led = readLedger()
  if (led.date !== t) {
    // 跨天：昨天(或上次记录的日期)的 todayUsage 归档进 history，保留最近 30 天
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {}
      led.history[led.date] = led.todayUsage
    }
    led.date = t
    led.lastBalance = currentBalance
    led.todayUsage = 0
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
  }
  const keys = Object.keys(led.history || {}).sort()
  while (keys.length > 30) {
    delete led.history[keys.shift()]
  }
  writeLedger(led)
  return led
}

module.exports = { USAGE_FILE, todayKey, readLedger, writeLedger, recordBalance }
