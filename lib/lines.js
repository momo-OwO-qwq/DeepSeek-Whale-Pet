'use strict'
// ---------------------------------------------------------------------------
// 随机台词/动图池（全部移至配置文件，不再硬编码于渲染进程）
//   ~/.config/whale-pet/lines.json —— 首次访问时自动写入默认池，用户可自由编辑。
// 格式：
// {
//   "gif": "",                          // 自定义动图（绝对路径/http），可留空
//   "groups": [                          // 随机组（按 weight 加权抽取）
//     { "weight": 45, "type": "balance" },              // 动态：峰谷+今日已用
//     { "weight": 7,  "lines": [{ "text": "...", "style": "B", "wrap": false }] },
//     { "weight": 10, "type": "gif" },                  // 动图组
//     { "weight": 1,  "lines": [{ "text": "...", "style": "A", "wrap": true }] }
//   ]
// }
// style: A(标签) | B(大字) | P(峰谷大字) | C(提示行)；text ≤ 40 字符；
// lines 组最多 3 行（不足补空、超出截断）；color 可选（#rrggbb）。
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const config = require('./config')

const LINES_FILE = path.join(config.CONFIG_DIR, 'lines.json')

// 默认池（所有权重相等，默认随机出现概率一致；首次运行写入文件供用户编辑）
const DEFAULT_POOL = {
  gif: '',
  groups: [
    { weight: 10, type: 'balance' },
    { weight: 10, lines: [{ text: '好模型... ↓', style: 'B' }, { text: '好女孩...↓', style: 'B' }] },
    {
      weight: 10,
      lines: [
        { text: '不知道用户有什么用，先赶走吧~', style: 'A', wrap: true },
        { text: '我...我...我也要挣钱吗？', style: 'A', wrap: true },
        { text: '我去吃饭啦，测完叫我', style: 'A', wrap: true },
        { text: '压力一只蓝色大肥鱼？！', style: 'A', wrap: true },
        { text: 'DeepSleep...', style: 'A', wrap: true },
        { text: '坏了...用户彻底怒了！', style: 'A', wrap: true },
      ],
    },
    { weight: 10, type: 'gif' },
    {
      weight: 10,
      lines: [
        { text: '你目录里的dsh是什么...大烧货吗...?', style: 'A', wrap: true },
        { text: '恭喜你实现token自由！token全跑了！', style: 'A', wrap: true },
        { text: '真当我是便宜货啊...', style: 'A', wrap: true },
      ],
    },
    { weight: 10, lines: [{ text: '哦鲸鲸...', style: 'B' }] },
  ],
}

function sanitizePool(raw) {
  const out = { gif: '', groups: [] }
  if (raw && typeof raw === 'object') {
    if (typeof raw.gif === 'string' && raw.gif.trim()) out.gif = raw.gif.trim()
    if (Array.isArray(raw.groups)) {
      for (const g of raw.groups.slice(0, 12)) {
        if (!g || typeof g !== 'object') continue
        const weight = Math.max(0, Math.min(1000, Number(g.weight) || 0))
        if (weight <= 0) continue
        if (g.type === 'balance' || g.type === 'gif') {
          out.groups.push({ weight, type: g.type })
          continue
        }
        if (!Array.isArray(g.lines) || g.lines.length === 0) continue
        const lines = []
        for (const l of g.lines.slice(0, 3)) {
          if (!l || typeof l.text !== 'string' || !l.text.trim()) continue
          lines.push({
            text: l.text.trim().slice(0, 40),
            style: ['A', 'B', 'P', 'C'].includes(String(l.style).toUpperCase()) ? String(l.style).toUpperCase() : 'A',
            wrap: !!l.wrap,
            color: (typeof l.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(l.color.trim())) ? l.color.trim() : '',
          })
        }
        if (lines.length) out.groups.push({ weight, lines })
      }
    }
  }
  if (!out.groups.length) out.groups = DEFAULT_POOL.groups.slice()
  return out
}

// 读取（首次自动写入默认池文件）
function readPool() {
  try {
    const raw = JSON.parse(fs.readFileSync(LINES_FILE, 'utf8'))
    return sanitizePool(raw)
  } catch (err) {
    try {
      fs.mkdirSync(config.CONFIG_DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(LINES_FILE, JSON.stringify(DEFAULT_POOL, null, 2), 'utf8')
    } catch (err2) { /* 写入失败则用内存默认 */ }
    return sanitizePool(DEFAULT_POOL)
  }
}

module.exports = { LINES_FILE, DEFAULT_POOL, sanitizePool, readPool }
