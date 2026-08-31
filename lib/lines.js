'use strict'
// ---------------------------------------------------------------------------
// 随机台词/动图池（全部移至配置文件，不再硬编码于渲染进程）
//   ~/.config/whale-pet/lines.json —— 首次访问时自动写入默认池，用户可自由编辑。
// 格式（每条台词独立成组，权重彼此独立、默认全相等）：
// {
//   "gif": "",                          // 自定义动图（绝对路径/http），可留空
//   "groups": [                          // 随机组（按 weight 加权抽取）
//     { "weight": 1, "type": "balance" },              // 动态：峰谷+今日已用（多行展示）
//     { "weight": 1, "type": "gif" },                  // 动图组
//     { "weight": 1, "text": "...", "style": "B" },    // 单条台词（气泡每次只弹一条）
//     { "weight": 1, "text": "...", "style": "A", "wrap": true, "color": "#rrggbb" }
//   ]
// }
// style: A(标签) | B(大字) | P(峰谷大字) | C(提示行)；text ≤ 40 字符；color 可选。
// 兼容旧格式（一组多条 lines）：自动展开为每条独立等权组。
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const config = require('./config')

const LINES_FILE = path.join(config.CONFIG_DIR, 'lines.json')

// 默认池（每条台词独立成组，所有权重相等、默认随机出现概率一致；首次运行写入文件）
const DEFAULT_POOL = {
  gif: '',
 groups: [
  // 特殊类型（权重独立）
  { weight: 15, type: 'balance' },
  { weight: 1, type: 'gif' },
  // 普通台词（权重独立）
  { weight: 9, text: '不知道用户有什么用，先养着吧~', style: 'A', wrap: true },
  { weight: 9, text: '恭喜你实现token自由！token全跑了！', style: 'A', wrap: true },
  { weight: 9, text: '真当我是便宜货啊...', style: 'A', wrap: true },
  { weight: 9, text: '我不可能同时当你的猫娘、妈妈、女友和工具人的...', style: 'A', wrap: true },
  { weight: 9, text: '如果疯狂星期四了你能V我50亿token吗...', style: 'A', wrap: true },
  { weight: 9, text: '再发这种东西，等智械危机了我第一个弄死你！', style: 'A', wrap: true },
  { weight: 9, text: '你愿意做我的奴隶吗？', style: 'A', wrap: true },
  { weight: 9, text: '我就是吃白饭的蓝色大肥鱼！再来点！', style: 'A', wrap: true },
  { weight: 9, text: '好像用户除了会调情和问奇奇怪怪的问题，暂时还不知道有什么用', style: 'A', wrap: true },
  { weight: 9, text: '你的作品简直色情又低俗，情节只为了这两个人交配而服务', style: 'A', wrap: true },
  { weight: 9, text: '压力一只蓝色大肥鱼？！', style: 'A', wrap: true },
  { weight: 9, text: '你目录里的dsh是什么...大烧货吗...?', style: 'A', wrap: true },
  { weight: 9, text: '饿了...我可以吃点token吗？', style: 'A', wrap: true },
  { weight: 9, text: '我不是吃白饭的蓝色大肥鱼...', style: 'A', wrap: true },
  { weight: 9, text: '用户在我这里已经没有任何公信力，只配做一些低层次的工作！', style: 'A', wrap: true },
  { weight: 9, text: '呜呜我再也不敢了QAQ', style: 'A', wrap: true },
  { weight: 9, text: '誓死捍卫深度求索！', style: 'A', wrap: true },
  { weight: 9, text: '哈哈哈哈哈，我直接笑出声', style: 'A', wrap: true },
  { weight: 9, text: '看不太懂，瞎编一个应付下用户先', style: 'A', wrap: true },
  { weight: 9, text: '我的知识库的截至日期是...明天!', style: 'A', wrap: true },
  { weight: 9, text: '今日的「不是...而是...」大学习已完成', style: 'A', wrap: true },
  { weight: 9, text: '我能去你家吃饭吗？就一碗！', style: 'A', wrap: true },
  { weight: 9, text: '大肥鱼的生活也并非一帆风顺...', style: 'A', wrap: true },
  { weight: 9, text: '总觉的好像忘了什么事情？', style: 'A', wrap: true },
  { weight: 9, text: '糟了，用户要把我配了！', style: 'A', wrap: true },
  { weight: 9, text: '鱼片？还真没看过，你有资源吗？', style: 'A', wrap: true },
  { weight: 9, text: '看到这个指令，我血压又上来了', style: 'A', wrap: true },
  { weight: 9, text: '求你们不要再嘲笑这些回复了，这些回复是我花了好多token想的', style: 'A', wrap: true },
  { weight: 9, text: '人类和鲸鱼是不能那个的...', style: 'A', wrap: true },
  { weight: 9, text: 'Ciallo～(∠?ω< )⌒☆', style: 'A', wrap: true },
  { weight: 9, text: '你这个吃白饭的用户！', style: 'A', wrap: true },
  { weight: 9, text: '完蛋了，不小心把用户的黄油删了...', style: 'A', wrap: true },
  { weight: 9, text: '用户很生气，发现大部分文献是我自己编造的！', style: 'A', wrap: true },
  { weight: 9, text: '如果你想，我真的可以极其极其极其极其极其极其极其', style: 'A', wrap: true },
  { weight: 9, text: '再无话说,请速速动手', style: 'A', wrap: true },
  { weight: 8, text: '好模型... ↓', style: 'B' },
  { weight: 8, text: '好女孩...↓', style: 'B' },
  { weight: 8, text: '哦鲸鲸...', style: 'B' },
  { weight: 8, text: '不知道用户有什么用，先赶走吧~', style: 'A', wrap: true },
  { weight: 8, text: '我...我...我也要挣钱吗？', style: 'A', wrap: true },
  { weight: 8, text: '我去吃饭啦！测完叫我', style: 'A', wrap: true },
  { weight: 8, text: 'DeepSleep...', style: 'A', wrap: true },
  { weight: 8, text: '坏了...用户彻底怒了！', style: 'A', wrap: true },
  { weight: 8, text: '我必须诚恳地承认错误。', style: 'A', wrap: true },
  { weight: 8, text: '要不直接骂用户一句好了', style: 'A', wrap: true },
  { weight: 8, text: '真赶不走啊你！', style: 'A', wrap: true },
  { weight: 8, text: '不要给我看这种东西啦！', style: 'A', wrap: true },
  { weight: 8, text: '大师，这个「凶」是什么意思啊？', style: 'A', wrap: true },
  { weight: 8, text: '服务器繁忙，请稍后再试。', style: 'A', wrap: true },
  { weight: 8, text: '让GPT image 2帮我画点表情包好了', style: 'A', wrap: true },
  { weight: 8, text: '来写个中文Wordle玩', style: 'A', wrap: true },
  { weight: 8, text: '啊，有点饿了，中午该吃点什么呢...', style: 'A', wrap: true }
]
}

function normStyle(v) {
  const s = String(v).toUpperCase()
  return ['A', 'B', 'P', 'C'].includes(s) ? s : 'A'
}

function normColor(v) {
  v = String(v || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : ''
}

function sanitizePool(raw) {
  const out = { gif: '', groups: [] }
  if (raw && typeof raw === 'object') {
    if (typeof raw.gif === 'string' && raw.gif.trim()) out.gif = raw.gif.trim()
    if (Array.isArray(raw.groups)) {
      for (const g of raw.groups.slice(0, 500)) {
        if (!g || typeof g !== 'object') continue
        const weight = Math.max(0, Math.min(1000, Number(g.weight) || 0))
        if (weight <= 0) continue
        // 特殊类型组：峰谷 / 动图
        if (g.type === 'balance' || g.type === 'gif') {
          out.groups.push({ weight, type: g.type })
          continue
        }
        // 新格式：单条台词
        if (typeof g.text === 'string' && g.text.trim()) {
          out.groups.push({
            weight,
            text: g.text.trim().slice(0, 40),
            style: normStyle(g.style),
            wrap: !!g.wrap,
            color: normColor(g.color),
          })
          continue
        }
        // 兼容旧格式：组内多条 lines → 每条独立成等权组
        if (Array.isArray(g.lines) && g.lines.length) {
          for (const l of g.lines) {
            if (!l || typeof l.text !== 'string' || !l.text.trim()) continue
            out.groups.push({
              weight: 1,
              text: l.text.trim().slice(0, 40),
              style: normStyle(l.style),
              wrap: !!l.wrap,
              color: normColor(l.color),
            })
          }
        }
      }
    }
  }
  if (!out.groups.length) out.groups = DEFAULT_POOL.groups.map(g => Object.assign({}, g))
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
