/* ============================================================================
 * 小鲸鱼桌宠 —— 渲染进程（鲸鱼窗口）
 * 移植自 DSH 原版 WIDGET_JS（lib/index.js 内嵌脚本）并适配 Linux 独立版：
 *   - 余额/配置/位置全部走 preload 桥（window.whaleAPI），不再有 /dsh-whale/* 路由
 *   - 窗口拖拽由主进程轮询光标移动窗口本体；渲染进程负责吸附与位置记忆
 *   - 新增：呼吸动画（CSS）、情绪表情、闲置半透明、预警换图
 *   - 移除：每轮消耗胶囊、滚动条避让（桌面无滚动条）、页面内汉堡菜单（改为独立设置窗口）
 *   - 点击：窗口始终接收事件（不做 OS 级穿透，Linux/XWayland 下不可靠），
 *     鲸鱼本体（isWhaleHit 画布 alpha）之外的点按直接忽略
 * ========================================================================== */
(function () {
  'use strict'
  if (window.__whalePetLoaded) return
  window.__whalePetLoaded = true

  var api = window.whaleAPI
  if (!api) { console.error('[whale-pet] preload bridge missing'); return }

  var BASE_PX = 320
  var MIN_SCALE = 0.6
  var MAX_SCALE = 2.5
  var CLICK_SQ = 9
  var ANIM_MS = 700
  var CHANGE_MS = 900
  var BUBBLE_MS = 5000
  var IDLE_MS = 3000

  // ------------------------------------------------------------------ DOM
  var root = document.createElement('div')
  root.className = 'wp-root'
  root.style.setProperty('--wp-base', BASE_PX + 'px')

  var body = document.createElement('div')
  body.className = 'wp-body'
  var breath = document.createElement('div')
  breath.className = 'wp-breath'

  var img = document.createElement('img')
  img.className = 'wp-img'
  img.src = '../assets/DSniang1.png'
  img.alt = 'DeepSeek 余额'
  img.draggable = false

  // 预警徽标（默认隐藏；达到预警额度且开启预警换图时显示）
  var alertBadge = document.createElement('div')
  alertBadge.className = 'wp-alert-badge'
  alertBadge.textContent = '!'

  breath.appendChild(img)
  breath.appendChild(alertBadge)

  var bubbleBox = document.createElement('div')
  bubbleBox.className = 'wp-bubble'
  bubbleBox.innerHTML =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="wp-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="wp-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="wp-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '</svg>'
  var gifEl = document.createElement('img')
  gifEl.className = 'wp-gif'
  gifEl.src = '../assets/rua.gif'
  gifEl.alt = ''
  gifEl.draggable = false
  var gifFailed = false
  gifEl.onerror = function () { gifFailed = true }
  bubbleBox.appendChild(gifEl)

  var textBox = document.createElement('div')
  textBox.className = 'wp-text'
  var labelEl = document.createElement('div')
  labelEl.className = 'wp-label'
  labelEl.textContent = 'DeepSeek 余额'
  var amountEl = document.createElement('div')
  amountEl.className = 'wp-amount'
  var hintEl = document.createElement('div')
  hintEl.className = 'wp-hint'
  textBox.appendChild(labelEl)
  textBox.appendChild(amountEl)
  textBox.appendChild(hintEl)
  bubbleBox.appendChild(textBox)

  var menuBtn = document.createElement('button')
  menuBtn.type = 'button'
  menuBtn.className = 'wp-menu-btn'
  menuBtn.title = '设置'
  menuBtn.innerHTML = '<span></span><span></span><span></span>'
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    api.openMenu()
  })

  body.appendChild(breath)
  body.appendChild(bubbleBox)
  root.appendChild(body)
  root.appendChild(menuBtn)
  document.body.appendChild(root)

  // ------------------------------------------------------------- 状态
  var state = {
    scale: 1,
    h: 'right',
    v: 'bottom',
    posX: null,
    posY: null,
    winW: BASE_PX,
    winH: BASE_PX,
    balance: null,
    currency: 'CNY',
    todayUsage: null,
    isPeak: false,
    status: 'loading',
    message: '',
  }
  var busy = false
  var refreshTimer = null
  var idleCheckTimer = null
  var animId = null
  var shown = null
  var animDelayTimer = null
  var settleTimer = null
  var drag = null
  var bubbleShown = false
  var bubbleTimer = null
  var bubbleRandomActive = false
  var bubbleRandomLines = null
  var bubbleSwapTimer = null
  var hintFadeTimer = null
  var gifFadeTimer = null
  var lastHintText = null
  var soundOn = true
  var soundVol = 0.8
  var soundSet = 'duck'
  var peakMode = 'default'
  var peakText = true
  var bubbleOn = true
  var bubbleIntervalMs = 120000
  var bubbleIntervalTimer = null
  var idleFade = true
  var refreshIntervalMs = 60000
  var threshold = 10
  var alertImage = false
  var mainImgPath = 'assets/DSniang1.png'
  var alertImgPath = 'assets/DSniang-sad.png'
  // 快速减少播报表情（随包「开心」素材）；'' = 不切换
  var dropImgPath = 'assets/DSniang-happy.png'
  var dropImage = true
  var dropImgHoldMs = 2600
  var bubbleTextOk = 'DeepSeek 余额'
  var bubbleTextLow = '余额预警'
  var textColorOk = ''
  var textColorLow = ''
  var peakTextOff = ''
  var peakTextOn = ''
  var pressSound = ''
  var releaseSound = ''
  var customGroups = null
  // v0.3.5：隐藏菜单按钮（右键/长按唤出）
  var menuBtnHide = false
  var audioGroup = 'duck'
  var roleId = 'default'
  var currentImgSrc = ''
  var lastPointerMoveAt = Date.now()
  var flipped = false
  var anchorCenterX = null // 屏幕水平中心：窗口位于左半侧 → 鲸鱼贴左（镜像），可触左边缘
  var anchorCenterY = null

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

  // ------------------------------------------------------------- 气泡
  function fmt(balance, currency) {
    var num = Number(balance)
    var fixed = isFinite(num) ? num.toFixed(2) : '--'
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
  }

  var BUBBLE_STYLE_CLASS = { A: 'wp-label', B: 'wp-amount', P: 'wp-period', C: 'wp-hint' }
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
  function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null] }

  function buildGroup1() {
    var peak = !!state.isPeak
    var offText = peakTextOff || '空闲时段'
    var peakTextStr = peakTextOn || '高峰时段'
    if (!peakTextOff && !peakTextOn) {
      if (peakMode === 'liangwen') { offText = '梁文谷'; peakTextStr = '梁文峰' }
      else if (peakMode === 'qiangqiang') { offText = '!?谷谷?!'; peakTextStr = '!?峰峰?!' }
    }
    // 峰谷：恢复原来的多行展示（当前时间段 / 高峰·空闲 / 今日已用）
    if (!peakText) {
      return [{ t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' }]
    }
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peak ? peakTextStr : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
      { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },
    ]
  }

  // 随机台词池完全来自 ~/.config/whale-pet/lines.json（含默认值，主进程首次
  // 自动生成文件）；渲染进程不再硬编码台词。
  var poolCache = null

  function buildCustomPool() {
    var groups = customGroups && Array.isArray(customGroups.groups) ? customGroups.groups : []
    var pool = []
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i]
      var weight = Number(g && g.weight)
      if (!isFinite(weight) || weight <= 0) continue
      if (g.type === 'balance') {
        pool.push({ w: weight, lines: buildGroup1 })
      } else if (g.type === 'gif') {
        pool.push({ w: weight, lines: function () { return { gif: true } } })
      } else if (g.text && String(g.text).trim()) {
        // 新格式：单条台词独立成组，气泡每次只弹这一条（避免多行同时输出）
        pool.push({ w: weight, lines: (function (grp) {
          return function () { return singleCenter(grp.style, grp.text, grp.color, grp.wrap) }
        })(g) })
      } else if (g.lines && g.lines.length) {
        // 兼容旧格式（一组多条 lines）：随机抽 1 条
        pool.push({ w: weight, lines: (function (grp) {
          return function () {
            var l = grp.lines[Math.floor(Math.random() * grp.lines.length)]
            return singleCenter(l.style, l.text, l.color, l.wrap)
          }
        })(g) })
      }
    }
    if (!pool.length) pool = [{ w: 45, lines: buildGroup1 }]
    return pool
  }

  function pickRandomLines() {
    if (!poolCache) poolCache = buildCustomPool()
    var total = 0
    for (var i = 0; i < poolCache.length; i++) total += poolCache[i].w
    var r = Math.random() * total
    for (var i = 0; i < poolCache.length; i++) {
      r -= poolCache[i].w
      if (r < 0) return poolCache[i].lines()
    }
    return poolCache[poolCache.length - 1].lines()
  }

  function applyBubbleLines(lines) {
    if (lines && lines.gif) {
      if (gifFailed) {
        lines = singleCenter('A', pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']), '', true)
      } else {
        if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
        gifEl.style.display = 'block'
        gifEl.style.opacity = ''
        labelEl.style.display = 'none'
        amountEl.style.display = 'none'
        hintEl.style.display = 'none'
        return
      }
    }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    var els = [labelEl, amountEl, hintEl]
    for (var i = 0; i < 3; i++) {
      var el = els[i]
      var ln = lines && lines[i]
      if (ln) {
        el.style.display = ''
        el.className = (BUBBLE_STYLE_CLASS[ln.s] || 'wp-label') + (ln.w ? ' wp-wrap' : '')
        el.textContent = ln.t
        el.style.color = ln.c || ''
      } else {
        el.style.display = 'none'
        el.textContent = ''
        el.style.color = ''
      }
    }
  }

  function setHint(text) {
    if (text === lastHintText) return
    var first = lastHintText === null
    lastHintText = text
    if (first || !bubbleShown) {
      hintEl.textContent = text
      return
    }
    hintEl.style.transition = 'opacity .18s ease'
    hintEl.style.opacity = '0'
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null
      hintEl.textContent = text
      hintEl.style.opacity = '1'
      setTimeout(function () {
        hintEl.style.transition = ''
        hintEl.style.opacity = ''
      }, 220)
    }, 190)
  }

  function swapBubbleContent(applyFn) {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    textBox.style.transition = 'opacity .18s ease'
    textBox.style.opacity = '0'
    bubbleSwapTimer = setTimeout(function () {
      bubbleSwapTimer = null
      applyFn()
      textBox.style.opacity = '1'
      setTimeout(function () {
        textBox.style.transition = ''
        textBox.style.opacity = ''
      }, 220)
    }, 190)
  }

  // ==========================================================================
  // 自定义泡泡渲染引擎（移植自上游 bubbleRenderModules / blockOf，v0.3.5）
  //
  // 上游把「一个泡泡 = 若干行，每行若干模块」渲染成绝对定位的绝对块。桌宠沿用
  // 同一套模型与视觉参数（字号以 --wp-u = base/1026 联动），但简化为一个
  // 独立的 #wp-mods 容器：启用自定义泡泡时隐藏内置三行文字，改由模块渲染。
  //
  // 约束（与 lib/bubble.js 保持一致，超限由上游已是「编辑器保证 + 渲染层防御」）：
  //   · 每行最多 6 个模块、最多 6 行、图片类模块独占一行且一个泡泡只能一个
  // ==========================================================================
  var modsBox = document.createElement('div')
  modsBox.className = 'wp-mods'
  bubbleBox.appendChild(modsBox)
  var modsEls = []          // 已渲染的模块元素（用于清理与动画）
  var customBubble = null   // 自定义泡泡配置（{v,items,lib,tapAdvance}）
  var customBubbleLimits = { modMax: 6, rowMax: 6, imgMax: 1 }
  var lastLineByMod = {}    // 随机语句/随机图片的「不连续重复」记忆（按模块键）
  var bubbleSeqIdx = 0      // 下一条待显示的序号（上游语义：显示时自增）
  var bubbleRoundOn = false // 是否处于「手动点击轮」

  // 字号：档位 → u 值（上游 bubbleModuleFontU），--wp-u 由 CSS 联动
  function moduleFontU(level) {
    var n = Number(level)
    if (!isFinite(n)) n = 6
    n = clamp(Math.round(n), 1, 50)
    return Math.round(40 + (n - 1) * 200 / 49)
  }

  // 当前余额/今日已用的展示文本（模块内容占位符取值）
  function moduleValues() {
    var amountText = shown !== null ? shown : (state.balance !== null ? state.balance : null)
    var bal = amountText === null ? '…' : fmt(amountText, state.currency)
    var today = state.todayUsage === null || state.todayUsage === undefined ? '--' : fmt(state.todayUsage, state.currency)
    var peakOn = peakLabelOn()
    return {
      balance: bal,
      today: today,
      status: peakOn ? '高峰时段' : '空闲时段',
      countdown: peakCountdownText(),
      cost: '--',
      quota: '--', quota_used: '--', quota_left: '--', quota_total: '--', quota_reset: '--',
    }
  }

  // 峰谷倒计时（上游 countdown 占位符）：距下一次切换的 hh:mm
  function peakCountdownText() {
    try {
      var now = new Date(Date.now() + 8 * 3600 * 1000) // 北京时间
      var day = now.getUTCDay()
      var h = now.getUTCHours()
      var weekend = day === 0 || day === 6
      if (weekend) return '周末全天谷价'
      var marks = [9, 12, 14, 18]
      var next = null
      for (var i = 0; i < marks.length; i++) if (h < marks[i]) { next = marks[i]; break }
      if (next === null) return '明日 09:00'
      var mins = (next - h) * 60 - now.getUTCMinutes()
      var hh = Math.floor(mins / 60)
      var mm = mins % 60
      return (hh > 0 ? hh + '小时' : '') + mm + '分后'
    } catch (err) { return '' }
  }

  function peakLabelOn() {
    try {
      var now = new Date(Date.now() + 8 * 3600 * 1000)
      var day = now.getUTCDay()
      if (day === 0 || day === 6) return false
      var h = now.getUTCHours()
      return (h >= 9 && h < 12) || (h >= 14 && h < 18)
    } catch (err) { return false }
  }

  // 占位符替换（与 lib/bubble.js renderTemplate 同语义：未知键原样保留）
  function fillTemplate(tpl, values) {
    var s = String(tpl === undefined || tpl === null ? '' : tpl)
    return s.replace(/\{([a-z_]+)\}/g, function (all, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all
    })
  }

  // 图片类模块：独占一整行，且一个泡泡只能有一个（与 lib/bubble.js 同规则）
  function isImgMod(m) {
    return !!m && (m.type === 'image' || m.type === 'randimg')
  }

  // 单个模块 → DOM 行内块（上游 blockOf 的等价实现，含逐模块字形/底色/跑马灯）
  function buildModuleEl(m, key) {
    var el
    if (isImgMod(m)) {
      el = document.createElement('img')
      el.className = 'wp-mod-img'
      var id = ''
      if (m.type === 'image') {
        id = m.imgId || ''
      } else {
        var imgs = Array.isArray(m.imgs) ? m.imgs : []
        var pickId = pickWeighted(imgs, lastLineByMod[key + ':img'])
        lastLineByMod[key + ':img'] = pickId
        id = pickId
      }
      el.alt = ''
      el.draggable = false
      if (id) {
        api.readBubbleImg(id).then(function (res) {
          if (res && res.ok) el.src = 'data:' + res.mime + ';base64,' + res.base64
        }).catch(function () {})
      }
      if (m.imgScale !== undefined) {
        el.style.height = (moduleFontU(6) / 1026 * 2.6 * m.imgScale) + 'em'
      }
      return el
    }
    el = document.createElement('span')
    el.className = 'wp-mod'
    var text = ''
    if (m.type === 'text') text = m.text || ''
    else if (m.type === 'link') { text = m.text || ''; el.classList.add('wp-mod-link') }
    else if (m.type === 'random') {
      var lines = Array.isArray(m.lines) ? m.lines : []
      var picked = pickWeighted(lines, lastLineByMod[key + ':ln'])
      lastLineByMod[key + ':ln'] = picked
      text = picked
    } else {
      // balance / today / peak / cost：内容模板 + 占位符
      text = fillTemplate(m.tpl, moduleValues())
    }
    el.textContent = text
    // 字号：以 px 为单位，随 --wp-u（= 窗口基准/1026）联动缩放
    var u = moduleFontU(m.size)
    el.style.fontSize = 'calc(' + u + ' * var(--wp-u))'
    el.style.setProperty('--wp-mod-u', String(u))
    if (m.bold) el.style.fontWeight = '800'
    if (m.italic) el.style.fontStyle = 'italic'
    if (m.ul) el.style.textDecoration = 'underline'
    if (m.color) el.style.color = m.color
    if (m.rgb) { el.classList.add('wp-rgb-' + m.rgb) }
    if (m.bg) el.style.background = m.bg
    if (m.bgrgb) el.classList.add('wp-bgrgb-' + m.bgrgb)
    if (m.wrap) el.classList.add('wp-mod-wrap')
    return el
  }

  // 加权抽样（通用；last 用于避免连续重复）
  function pickWeighted(list, last) {
    var arr = (Array.isArray(list) ? list : []).filter(function (x) {
      return x && (typeof x === 'string' ? x : (x.t || x.id))
    })
    if (!arr.length) return ''
    var pool = arr
    if (arr.length > 1 && last) {
      var filtered = arr.filter(function (x) {
        var v = typeof x === 'string' ? x : (x.t || x.id)
        return v !== last
      })
      if (filtered.length) pool = filtered
    }
    var total = 0
    var i
    for (i = 0; i < pool.length; i++) total += Math.max(1, Math.round(Number(pool[i] && pool[i].w) || 1))
    var r = Math.random() * total
    var acc = 0
    for (i = 0; i < pool.length; i++) {
      acc += Math.max(1, Math.round(Number(pool[i] && pool[i].w) || 1))
      if (r < acc) return typeof pool[i] === 'string' ? pool[i] : (pool[i].t || pool[i].id)
    }
    var last2 = pool[pool.length - 1]
    return typeof last2 === 'string' ? last2 : (last2.t || last2.id)
  }

  // 模块数组 → 行数组（与 lib/bubble.js rowsOf 同规则：row 键合并、图片独占行）
  function rowsOf(mods) {
    var out = []
    var cur = null
    for (var i = 0; i < (mods || []).length; i++) {
      var m = mods[i] || {}
      var isImg = isImgMod(m)
      if (isImg) { out.push([m]); cur = null; continue }
      var key = (typeof m.row === 'number' && isFinite(m.row) && Math.round(m.row) === m.row && m.row > 0) ? m.row : null
      if (cur && cur.key !== null && key === cur.key) { cur.row.push(m); continue }
      cur = { key: key, row: [m] }
      out.push(cur.row)
    }
    return out.slice(0, customBubbleLimits.rowMax)
  }

  // 渲染一个自定义泡（items[idx] 落地后调用）
  function renderCustomBubble(modules) {
    clearMods()
    var rows = rowsOf(modules)
    var values = moduleValues()
    for (var r = 0; r < rows.length; r++) {
      var rowEl = document.createElement('div')
      rowEl.className = 'wp-modrow'
      rowEl.style.setProperty('--wp-row-i', String(r))
      // 逐行进入动画（CSS 按下标错峰）
      rowEl.style.animationDelay = (r * 70) + 'ms'
      for (var c = 0; c < rows[r].length; c++) {
        var mod = rows[r][c]
        rowEl.appendChild(buildModuleEl(mod, 'r' + r + 'c' + c))
      }
      modsBox.appendChild(rowEl)
      modsEls.push(rowEl)
    }
    modsBox.style.display = rows.length ? 'flex' : 'none'
    // 自定义泡存在时隐藏内置三行文字
    labelEl.style.display = 'none'
    amountEl.style.display = 'none'
    hintEl.style.display = 'none'
    gifEl.style.display = 'none'
  }

  function clearMods() {
    for (var i = 0; i < modsEls.length; i++) {
      if (modsEls[i] && modsEls[i].parentNode) modsEls[i].parentNode.removeChild(modsEls[i])
    }
    modsEls = []
    modsBox.style.display = 'none'
  }

  // 自定义泡泡是否可用（有 items 即接管；否则完全走原有内置逻辑）
  function hasCustomBubble() {
    return !!(customBubble && Array.isArray(customBubble.items) && customBubble.items.length)
  }

  // 取第 idx 项并落地（choice → 按权重抽一个候选，上游 bubblePickChoiceStep）
  function resolveBubbleStep(idx) {
    var items = (customBubble && customBubble.items) || []
    if (idx < 0 || idx >= items.length) return null
    var it = items[idx]
    if (it && it.kind === 'choice' && Array.isArray(it.options) && it.options.length) {
      var total = 0
      var i
      for (i = 0; i < it.options.length; i++) total += Math.max(1, Math.round(Number(it.options[i] && it.options[i].w) || 1))
      var r = Math.random() * total
      var acc = 0
      for (i = 0; i < it.options.length; i++) {
        acc += Math.max(1, Math.round(Number(it.options[i] && it.options[i].w) || 1))
        if (r < acc) return (it.options[i] && it.options[i].item) || { kind: 'normal' }
      }
      return (it.options[it.options.length - 1].item) || { kind: 'normal' }
    }
    return it || { kind: 'normal' }
  }

  // 显示「下一条」并自增序号（上游 bubbleShowSeqNext 的语义：显示时自增）
  function showSeqNext() {
    if (!hasCustomBubble()) return false
    var items = customBubble.items
    if (bubbleSeqIdx >= items.length) { return false }
    var resolved = resolveBubbleStep(bubbleSeqIdx)
    bubbleSeqIdx++
    if (!resolved) return false
    if (resolved.kind === 'custom' && Array.isArray(resolved.modules)) {
      renderCustomBubble(resolved.modules)
      return true
    }
    // normal / random 交给原有内置渲染（random 用内置随机台词池）
    clearMods()
    if (resolved.kind === 'random') {
      applyBubbleLines(pickRandomLines())
    } else {
      restoreBubbleLines()
    }
    return true
  }

  function restoreBubbleLines() {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    lastHintText = null
    clearMods()
    textBox.style.transition = ''
    textBox.style.opacity = ''
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    labelEl.style.display = ''
    labelEl.className = 'wp-label'
    labelEl.style.color = ''
    setStateLabel()
    amountEl.style.display = ''
    amountEl.className = 'wp-amount'
    amountEl.style.color = ''
    hintEl.style.display = ''
    hintEl.className = 'wp-hint'
    hintEl.style.color = ''
    render()
  }

  function showBubble() {
    if (!bubbleOn) return
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    bubbleShown = true
    bubbleRandomActive = false
    restoreBubbleLines()
    bubbleBox.classList.add('wp-bubble-open')
    reportShape()
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  // 点击回调函数的可选注入：测试/无 preload 环境下降级为直接 showBubble
  function openMenuSafe() {
    try { api.openMenu() } catch (err) {}
  }

  // ------------------------------------------------------------------ 点击鲸鱼
  // 严格移植上游 whaleClick：
  //   · 未显示 → 开新轮，从第 1 项开始（bubbleSeqIdx = 0 后在显示时自增）
  //   · 开启 tapAdvance → 点角色 = 往后推进一项；已是最后一项则收起
  //   · 关闭 tapAdvance（默认）→ 正在看第 1 项只续时；第 2 项及以后回到第 1 项
  // 关键：bubbleSeqIdx 是「显示时自增」的，因此 idx<=1 恰好表示「正显示第 1 项」。
  // ------------------------------------------------------------------ 点击鲸鱼
  // 语义（桌宠版，对上游 whaleClick 的必要改造）：
  //
  // 上游有两个可点对象：**鲸鱼**（回到第 1 项 / 续时）与**气泡**（推进到下一项）。
  // 桌宠里气泡是纯装饰、不可点，只有一个交互面。若照搬「点鲸鱼不推进」，
  // 用户永远看不到第 2 项及以后（实测：点两次仍停在第一项）。
  //
  // 因此桌宠版统一为「点一下就往后走一项」，与 tapAdvance 开关解耦：
  //   未显示      → 开新轮，显示第 1 项
  //   还有下一项  → 推进到下一项
  //   已是最后一项 → 收起泡泡（下次点击从第 1 项开始）
  //
  // tapAdvance 仍然有意义：它控制「收起后是否记住位置」的观感 —— 见 bubbleNext。
  // 这样无论开关如何，用户都能完整走完序列，不会卡在第一项。
  function onWhaleTap() {
    if (!bubbleOn) return
    if (!bubbleShown) {
      bubbleRoundOn = true
      bubbleSeqIdx = 0
      startRound()
      return
    }
    bubbleNext()
  }

  // 开新轮：有自定义泡泡配置则走配置序列，否则回落到内置行为
  function startRound() {
    // 关键：bubbleShown 必须在渲染自定义泡时一并置真。
    // 旧实现只加了 CSS 类、没置这个标志，于是下一次点击看到 bubbleShown=false，
    // 又当成「全新一轮」重新渲染第 1 项 —— 表现为「点第二下没反应、永远停在第 1 项」。
    if (!showSeqNext()) {
      // 无自定义配置（或序列已尽）→ 原有行为：余额泡 + 自动随机台词
      showBubble()
    } else {
      bubbleShown = true
      bubbleRandomActive = false
      bubbleBox.classList.add('wp-bubble-open')
      reportShape()
      resetBubbleTtl()
    }
  }

  // 推进到下一项；已是最后一项则关闭
  function bubbleNext() {
    if (!bubbleShown) return
    var total = (customBubble && Array.isArray(customBubble.items)) ? customBubble.items.length : 0
    if (bubbleRoundOn && customBubble && bubbleSeqIdx < total) {
      // 还有下一项：淡出淡入切换内容，不收起气泡
      swapBubbleContent(function () {
        if (!showSeqNext()) hideBubble()
      })
      resetBubbleTtl()
      return
    }
    // 自定义序列已走完 → 收起；下次点击重新从第 1 项开始
    if (customBubble && total > 0) {
      hideBubble()
      return
    }
    // 无自定义配置：沿用内置「点一下切台词 / 再点收起」的既有行为
    hideBubble()
  }

  function resetBubbleTtl() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  // 自动随机台词：每 bubbleInterval 秒弹一次「随机台词」气泡（非余额内容）。
  // 点击气泡切换/关闭行为不变；自动触发时直接展示随机台词段。
  function showRandomBubble() {
    // 守卫：关闭气泡、拖拽中、已有气泡展开（用户正在看）时不打断自动弹出
    if (!bubbleOn) return
    if (bubbleShown) return
    if (drag && drag.active) return
    if (state.status === 'error') return // 出错时不打扰
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    bubbleShown = true
    bubbleRandomActive = true
    bubbleRandomLines = pickRandomLines()
    applyBubbleLines(bubbleRandomLines)
    bubbleBox.classList.add('wp-bubble-open')
    reportShape()
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    textBox.style.transition = ''
    textBox.style.opacity = ''
    hintEl.style.transition = ''
    hintEl.style.opacity = ''
    bubbleRandomActive = false
    bubbleRandomLines = null
    bubbleShown = false
    // 收起即结束本轮：下次点击必须重新从第 1 项开始（否则会断点续播，观感像卡住）
    bubbleRoundOn = false
    bubbleSeqIdx = 0
    // 清掉自定义模块，否则收起后 DOM 仍残留（下次开局会叠加上一份内容）
    clearMods()
    bubbleBox.classList.remove('wp-bubble-open')
    reportShape()
    gifFadeTimer = setTimeout(function () {
      gifFadeTimer = null
      gifEl.style.display = 'none'
    }, 240)
  }

  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!bubbleShown) return
    // 气泡展开时它会覆盖鲸鱼点击区（open 态 svg 可点），因此「点气泡」必须在
    // 自定义泡泡启用时**推进序列**，而不是老的无条件切随机台词 —— 后者会把
    // 用户困在第 1 项（实测：点两次仍停在第 1 项）。
    if (customBubble && Array.isArray(customBubble.items) && customBubble.items.length) {
      bubbleNext()
      return
    }
    if (bubbleRandomActive) {
      hideBubble()
    } else {
      bubbleRandomActive = true
      bubbleRandomLines = pickRandomLines()
      swapBubbleContent(function () { applyBubbleLines(bubbleRandomLines) })
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
    }
  })

  // ------------------------------------------------------------- 渲染刷新
  function animateAmount(from, to, currency, duration) {
    if (animId) cancelAnimationFrame(animId)
    if (from === null || !isFinite(from)) from = to
    if (from === to) {
      shown = to
      amountEl.textContent = fmt(to, currency)
      return
    }
    var startTime = null
    function step(ts) {
      if (startTime === null) startTime = ts
      var t = Math.min(1, (ts - startTime) / duration)
      var eased = 1 - Math.pow(1 - t, 3)
      var val = from + (to - from) * eased
      amountEl.textContent = fmt(val, currency)
      if (t < 1) {
        animId = requestAnimationFrame(step)
      } else {
        animId = null
        shown = to
        amountEl.textContent = fmt(to, currency)
      }
    }
    animId = requestAnimationFrame(step)
  }

  function render() {
    var amount, hint
    if (state.status === 'error') {
      amount = shown !== null ? fmt(shown, state.currency) : '--'
      hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试'
    } else if (state.balance === null) {
      amount = shown !== null ? fmt(shown, state.currency) : '…'
      hint = '加载中…'
    } else {
      amount = shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency)
      hint = '今日已用 ' + (state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--')
    }
    amountEl.textContent = amount
    if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines)
    } else {
      setHint(hint)
      setStateLabel()
    }
    updateHeroImage()
  }

  function isLowBalance() {
    return state.status === 'ok' && state.balance !== null && isFinite(state.balance) &&
      state.balance >= 0 && state.balance < threshold
  }

  // 气泡第一行：余额充足/预警 两套自定义文案（限 20 字符，config 已消毒）
  function setStateLabel() {
    var low = isLowBalance()
    var t = low ? (bubbleTextLow || 'DeepSeek 余额') : (bubbleTextOk || 'DeepSeek 余额')
    var c = low ? textColorLow : textColorOk
    if (labelEl.textContent !== t) labelEl.textContent = t
    if (labelEl.style.color !== c) labelEl.style.color = c
  }

  // 自定义随机台词/动图池（~/.config/whale-pet/lines.json，含全部默认值）
  function applyCustom(data) {
    customGroups = data && Array.isArray(data.groups) ? data : null
    poolCache = null // 池变化 → 重建
    var gif = data && typeof data.gif === 'string' && data.gif.trim() ? data.gif.trim() : ''
    try {
      var want = gif ? resolveImgPath(gif) : '../assets/rua.gif'
      var cur = gifEl.getAttribute('src')
      if (cur !== want) gifEl.setAttribute('src', want)
    } catch (err) {}
  }

  function resolveImgPath(p) {
    var s = String(p || '').trim()
    if (!s) return ''
    // http/https/file 或绝对路径原样使用
    if (/^(https?:|file:)/.test(s)) return s
    if (s.charAt(0) === '/') return 'file://' + s
    // 相对路径基于应用根目录：renderer/pet.html 位于 renderer/ 下 → ../assets/
    return s.indexOf('assets/') === 0 ? '../' + s : '../' + s
  }

  // 主形象 / 预警表情 / 播报表情 三选一。
  // 优先级（高 → 低）：
  //   1. 预警表情（余额低于阈值）—— 「必须看见」的状态，压过一切
  //   2. 播报表情（余额快速减少）—— 短暂的表情反馈，见 triggerDropFace()
  //   3. 自定义角色图（用户上传）
  //   4. 主图
  function updateHeroImage() {
    var low = alertImage && isLowBalance()
    if (low) {
      applyImgSrc(resolveImgPath(alertImgPath))
      alertBadge.classList.add('wp-alert-badge-show')
      return
    }
    alertBadge.classList.remove('wp-alert-badge-show')
    // 快速减少播报期间显示开心表情（仅在未触发预警时）
    if (dropFaceUntil > 0 && Date.now() < dropFaceUntil && dropImage && dropImgPath) {
      applyImgSrc(resolveImgPath(dropImgPath))
      return
    }
    if (roleId && roleId !== 'default' && roleImgSrc) { applyImgSrc(roleImgSrc); return }
    applyImgSrc(resolveImgPath(mainImgPath))
  }

  function applyImgSrc(want) {
    if (!want || want === currentImgSrc) return
    currentImgSrc = want
    img.src = want
    setupHitTest(want)
  }

  // ------------------------------------------------------- 快速减少播报表情
  // 余额下降被观测到时切到「开心」表情并保持一小段时间，随后自动回落。
  // 与记账/任务结束音共用同一个信号（余额下降 = 观测到一次消费）。
  var dropFaceUntil = 0      // 播报表情的截止时间戳（0 = 未激活）
  var dropFaceTimer = null

  function triggerDropFace() {
    if (!dropImage || !dropImgPath) return
    // 预警状态优先：不覆盖预警表情
    if (alertImage && isLowBalance()) return
    var hold = dropImgHoldMs > 0 ? dropImgHoldMs : 0
    if (hold <= 0) return
    dropFaceUntil = Date.now() + hold
    updateHeroImage()
    if (dropFaceTimer) { clearTimeout(dropFaceTimer); dropFaceTimer = null }
    dropFaceTimer = setTimeout(function () {
      dropFaceTimer = null
      dropFaceUntil = 0
      updateHeroImage()
    }, hold + 40) // 多留一帧，避免边界竞争
  }

  // 加载自定义角色的图片（data URL；default 走内置主图）
  var roleImgSrc = ''
  function loadRoleImage() {
    if (!api.readRole) return
    if (!roleId || roleId === 'default') { roleImgSrc = ''; updateHeroImage(); return }
    api.readRole(roleId).then(function (res) {
      if (!res || !res.ok) {
        // 角色不存在（被删）→ 回退默认，避免白图
        roleId = 'default'
        roleImgSrc = ''
        api.setConfig({ roleId: 'default' })
      } else {
        roleImgSrc = 'data:' + res.mime + ';base64,' + res.base64
      }
      updateHeroImage()
    }).catch(function () {})
  }

  async function refresh(manual) {
    if (busy) return
    busy = true
    if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null }
    if (manual || state.balance === null) { state.status = 'loading'; render() }
    try {
      var data = await api.getBalance()
      if (data && data.ok) {
        var nb = Number(data.totalBalance)
        var nc = String(data.currency || 'CNY')
        var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
        var currencyChanged = state.currency !== null && nc !== state.currency
        // 任务结束音：余额下降 = 观测到一次消费完成（同币种、非首次加载、非手动刷新）
        var consumed = !currencyChanged && state.balance !== null && typeof nb === 'number' &&
          typeof state.balance === 'number' && nb < state.balance
        state.balance = nb
        state.currency = nc
        state.message = ''
        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
        state.isPeak = !!data.isPeak
        // 余额下降 = 观测到一次消费：播报表情 + 任务结束音（同一个信号）
        if (consumed && !manual) {
          triggerDropFace()
          playTaskEndSound()
        }
        if (changed && !currencyChanged) {
          if (!manual) {
            showBubble()
            state.status = 'changing'
            if (animDelayTimer) clearTimeout(animDelayTimer)
            animDelayTimer = setTimeout(function () {
              animDelayTimer = null
              animateAmount(shown, nb, nc, ANIM_MS)
            }, 300)
            if (settleTimer) clearTimeout(settleTimer)
            settleTimer = setTimeout(function () {
              settleTimer = null
              if (state.status === 'changing') { state.status = 'ok'; render() }
            }, CHANGE_MS + 300)
          } else {
            animateAmount(shown, nb, nc, ANIM_MS)
            state.status = 'ok'
            render()
          }
        } else {
          if (animId === null) shown = nb
          state.status = 'ok'
          render()
        }
      } else {
        state.status = 'error'
        state.message = (data && data.error) ? String(data.error) : '获取失败'
        render()
      }
    } catch (err) {
      state.status = 'error'
      state.message = '获取失败'
      render()
    } finally {
      busy = false
    }
  }

  // ------------------------------------------------------------- 位置与吸附
  async function initPosition() {
    var wa = await api.getWorkArea()
    var bd = await api.getDisplayBounds()
    var cfg = await api.getConfig()
    var x, y
    if (typeof cfg.posX === 'number' && typeof cfg.posY === 'number') {
      // 用与拖拽一致的钳制：贴左/贴顶的记忆位置（负坐标）重启后仍保持贴边
      var p = settlePos(cfg.posX, cfg.posY, bd, wa)
      x = p.x
      y = p.y
    } else {
      x = wa.x + wa.width - state.winW // 默认右下角
      y = wa.y + wa.height - state.winH
      advancePos(x, y)
    }
    await api.setWindowPos(x, y)
  }

  function advancePos(x, y) {
    state.posX = x
    state.posY = y
    updateAnchor()
  }

  // 可见鲸鱼在窗口内的矩形（CSS px = DIP，含镜像）：贴边钳制的唯一依据
  // - 用 offset*（布局盒）而非 getBoundingClientRect，避免呼吸动画 transform 抖动
  // - 镜像（.wp-left）时图形贴窗口左缘 → 矩形整体翻转，左右贴边方向自动适配
  // - 有 alpha 包围盒时按可见部分收缩（图片自带的透明留白不计入），否则退回图片框
  function fishRect() {
    var x = img.offsetLeft, y = img.offsetTop, w = img.offsetWidth, h = img.offsetHeight
    if (!(w > 0) || !(h > 0)) return null
    if (hitBBox) {
      var vx = x + w * hitBBox.x0
      var vy = y + h * hitBBox.y0
      w = w * (hitBBox.x1 - hitBBox.x0)
      h = h * (hitBBox.y1 - hitBBox.y0)
      x = vx
      y = vy
    }
    if (flipped) x = state.winW - (x + w)
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
  }

  // 位置钳制：可见图形的四条边都能贴到屏幕边（左/上允许负坐标，把图片留白推出屏幕）。
  // 与主进程拖拽钳制同一套规则（左右按显示器边界、底部按工作区不藏任务栏）。
  function clampPos(x, y, bd, wa) {
    var fr = fishRect()
    if (!fr) {
      var headRoom = Math.round(state.winH * 0.4055)
      return {
        x: clamp(x, bd.x - headRoom, Math.max(bd.x, bd.x + bd.width - state.winW)),
        y: clamp(y, bd.y - headRoom, Math.max(wa.y, wa.y + wa.height - state.winH)),
      }
    }
    return {
      x: clamp(x, bd.x - fr.x, Math.max(bd.x, bd.x + bd.width - (fr.x + fr.w))),
      y: clamp(y, bd.y - fr.y, Math.max(wa.y, wa.y + wa.height - (fr.y + fr.h))),
    }
  }

  // 定位收敛（两遍）：镜像方向会随窗口跨过屏幕中线而切换，而镜像后可见图形在窗口
  // 内的左右位置正好相反 —— 先按当前方向钳制，切换方向后再按新矩形复钳一次，
  // 否则「拖到右缘松手 → 鲸鱼翻到另一侧 → 一截被屏幕切掉」。两遍在真实窗口尺寸下
  // 必然收敛（钳制后的位置不会跨回中线），不做循环以免来回跳。
  function settlePos(x, y, bd, wa) {
    var a = clampPos(x, y, bd, wa)
    advancePos(a.x, a.y)
    var b = clampPos(a.x, a.y, bd, wa)
    if (b.x !== a.x || b.y !== a.y) advancePos(b.x, b.y)
    return b
  }

  // 换图/探针就绪后按最新的可见范围收紧位置（拖拽中不动，由主进程引擎接管）
  async function reclampPos() {
    if (drag && drag.active) return
    try {
      var bd = await api.getDisplayBounds()
      var wa = await api.getWorkArea()
      var wasX = state.posX
      var wasY = state.posY
      var p = settlePos(wasX, wasY, bd, wa)
      if (p.x === wasX && p.y === wasY) return // 位置无需收紧（settlePos 已同步 state）
      await api.setWindowPos(p.x, p.y)
      reportShape()
    } catch (err) {}
  }

  // 方向感知锚点：窗口中心在屏幕左半 → 鲸鱼贴窗口左缘（水平镜像）→ 可触及左边缘
  function updateAnchor() {
    if (anchorCenterX === null) return
    var onLeft = state.posX + state.winW / 2 < anchorCenterX
    if (onLeft !== flipped) {
      flipped = onLeft
      root.classList.toggle('wp-left', flipped)
      reportShape() // 镜像后形状需随之镜像
    }
  }

  // ---------- 不再裁剪窗口（按用户要求移除 setShape）----------
  // 保留空实现是为了不动散落各处的调用点（换图/开合气泡/缩放/镜像后都会调），
  // 避免为删一个副作用而改动多处流程。主进程侧同样已忽略 pet:shape。
  //
  // 移除原因（三个都是实际踩到的）：
  //   1) 气泡被一起裁掉：气泡展开时超出鲸鱼矩形就被切边（用户明确要求不要裁剪气泡）；
  //   2) 早期 {x,y,w,h} 键名不合法导致 setShape **每次都静默失败**，窗口其实
  //      一直是完整矩形 —— 「透明部分有遮挡」与「时好时坏」都源于此；
  //   3) 缩放后 shape 若未及时跟上，右下角那片不在裁剪区内 → 点不到、拖不动，
  //      表现为「调整大小后拖不到右下角，重启才好」。
  // 现在窗口保持完整矩形：交互稳定、气泡完整、缩放后行为一致。
  function reportShape() {}

  async function setScale(v) {
    var next = Math.round(clamp(Number(v), MIN_SCALE, MAX_SCALE) * 10) / 10
    if (next === state.scale) return
    var oldW = state.winW, oldH = state.winH
    var newW = Math.round(BASE_PX * next)
    var newH = newW
    // 固定鲸鱼右下角（无镜像翻转，锚点唯一）
    var fixX = state.posX + oldW
    var fixY = state.posY + oldH
    state.scale = next
    // 主进程已等到真实尺寸生效才返回（见 window:resize 注释）：
    // 碰撞箱（点击区/拖拽/钳制）与 CSS 视觉尺寸必须同源，否则 Linux/Wayland 下
    // 「视觉缩小、碰撞箱未缩小」会出现右/下空气墙（由大变小时最明显）。
    // IPC 失败不能让缩放整条路径崩掉：任一调用抛错时退回请求尺寸，继续走完
    // CSS 更新与 shape 上报（否则会出现「窗口没变、透明区还挡着」的观感）。
    var rb = await api.resizeWindow(newW, newH).catch(function () { return null })
    var realW = (rb && rb.width > 0) ? rb.width : newW
    var realH = (rb && rb.height > 0) ? rb.height : newH
    root.style.setProperty('--wp-base', realW + 'px')
    state.winW = realW
    state.winH = realH
    // 关键：CSS 尺寸变化会**异步**触发布局，img 的 offsetWidth 要到下一帧才更新。
    // 若此刻立刻调用 settlePos，fishRect() 读到的还是旧布局 → 按旧矩形钳制 →
    // 缩小后右侧/底部留下「空气墙」。这里等一帧，保证按新布局计算。
    await nextFrame()
    var x = fixX - realW
    var y = fixY - realH
    var d2 = await api.getDisplayBounds().catch(function () { return null })
    var wa2 = await api.getWorkArea().catch(function () { return null })
    if (!d2 || !wa2) { api.setConfig({ scale: next }); return }
    // 与拖拽引擎同一套钳制（按可见图形矩形，而非固定的 40.55% 留白估算）
    var fit = settlePos(x, y, d2, wa2)
    x = fit.x
    y = fit.y
    var rp = await api.setWindowPos(x, y).catch(function () { return null })
    if (rp && isFinite(rp.x) && isFinite(rp.y)) { x = Math.round(rp.x); y = Math.round(rp.y); advancePos(x, y) }
    // 再等一帧后复钳一次：镜像方向/可见范围可能刚变化，二次收敛避免残留死区
    await nextFrame()
    var fit2 = settlePos(x, y, d2, wa2)
    if (fit2.x !== x || fit2.y !== y) {
      x = fit2.x
      y = fit2.y
      await api.setWindowPos(x, y).catch(function () { return null })
      advancePos(x, y)
    }
    api.setConfig({ scale: next, posX: x, posY: y })
    // shape 必须在布局稳定后上报：上面已等过帧，这里再等到「图片尺寸确实等于
    // 新基准推算值」才报，避免把旧布局的矩形交给 setShape（那会让裁剪框与新窗口
    // 不匹配，透明区域继续吃点击）。最多重试若干帧。
    await waitForImageSize(Math.round(realW * 0.5945))
    reportShape()
  }

  // 等到 img 布局尺寸达到期望值（最多 ~10 帧）；超时也返回，不阻塞
  function waitForImageSize(expectW) {
    return new Promise(function (resolve) {
      var tries = 0
      function check() {
        tries++
        if (Math.abs(img.offsetWidth - expectW) <= 1 || tries > 10) return resolve()
        nextFrame().then(check)
      }
      check()
    })
  }

  // 等一帧（布局生效）；无 rAF 环境（测试）时退化为微任务
  function nextFrame() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { resolve() })
      else setTimeout(resolve, 0)
    })
  }

  // ------------------------------------------------------------- 命中测试
  var hitCanvas = null
  var hitReady = false
  // 图形 alpha 包围盒（0-1 归一化，见 alphaBBox()）。初值 = 内置素材 DSniang1.png
  // 的实测留白（左 45/610、上 10/610），供探针就绪前的定位使用；探针加载后按
  // 实际图片（含用户上传图）重新计算覆盖。
  var hitBBox = { x0: 45 / 610, y0: 10 / 610, x1: 1, y1: 1 }

  // 可见图形的 alpha 包围盒：图片自带透明留白（如 DSniang1 左 7.4%/上 1.6%），
  // 贴边钳制必须按「肉眼可见的鲸鱼」而非图片框，否则贴到边上时视觉上差一截
  function alphaBBox(ctx, n) {
    try {
      var d = ctx.getImageData(0, 0, n, n).data
      var x0 = n, y0 = n, x1 = -1, y1 = -1
      for (var y = 0; y < n; y++) {
        for (var x = 0; x < n; x++) {
          if (d[(y * n + x) * 4 + 3] > 10) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      if (x1 < 0) return null
      return { x0: x0 / n, y0: y0 / n, x1: (x1 + 1) / n, y1: (y1 + 1) / n }
    } catch (err) { return null }
  }

  function setupHitTest(src) {
    try {
      var probe = new Image()
      hitReady = false // 探针重载期间：命中测试放宽为「全命中」，保证可点击
      probe.onload = function () {
        try {
          hitCanvas = hitCanvas || document.createElement('canvas')
          hitCanvas.width = 610
          hitCanvas.height = 610
          var ctx = hitCanvas.getContext('2d')
          ctx.drawImage(probe, 0, 0, 610, 610)
          hitReady = true
          hitBBox = alphaBBox(ctx, 610)
          reclampPos() // 换图后可见范围可能变化 → 按新矩形重新收紧位置
        } catch (err) {}
      }
      probe.onerror = function () { /* hitReady 保持 false → 全命中，可点击优先 */ }
      probe.src = src || '../assets/DSniang1.png'
    } catch (err) {}
  }

  function isWhaleHit(e) {
    if (!hitCanvas || !hitReady) return true
    try {
      var r = img.getBoundingClientRect()
      if (!r || r.width <= 0 || r.height <= 0) return false
      var lx = (e.clientX - r.left) / r.width * 610
      var ly = (e.clientY - r.top) / r.height * 610
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
      if (flipped) lx = 610 - lx // 镜像后坐标映射需反转
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
      return data[3] > 10
    } catch (err) {
      return true
    }
  }

  // 是否在「可点击区域」内（鲸鱼盒 / 气泡盒 / 按钮盒）—— 用于显示汉堡按钮：
  // 鼠标从鲸鱼滑向按钮时若已离开鲸鱼 alpha，仍应保持按钮可见（避免三横线消失）。
  function inClickable(e) {
    try {
      var r = img.getBoundingClientRect()
      if (r && e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6) return true
      var m = menuBtn.getBoundingClientRect()
      if (m && e.clientX >= m.left - 6 && e.clientX <= m.right + 6 && e.clientY >= m.top - 6 && e.clientY <= m.bottom + 6) return true
      if (bubbleShown) {
        var b = bubbleBox.getBoundingClientRect()
        if (b && e.clientX >= b.left - 6 && e.clientX <= b.right + 6 && e.clientY >= b.top - 6 && e.clientY <= b.bottom + 6) return true
      }
      return isWhaleHit(e)
    } catch (err) { return isWhaleHit(e) }
  }

  // ------------------------------------------------------------- 指针交互
  // 拖拽：窗口移动全部由主进程拖拽引擎完成（单一权威，见 main.js 拖拽引擎注释）
  // 渲染进程只上报两类原始数据：位移增量（e.movementX/Y）与光标绝对坐标，
  // 自身绝不做任何位移运算（client/screen 与窗口位置耦合，曾导致抽搐与飞移）
  // setPointerCapture 保证窗口外松手不掉拖。
  //
  // 光标绝对坐标（渲染进程 CSS 像素空间）：e.screenX/screenY 是 OS 下发的真实值，
  // 单轴为 0 是真实边界坐标（光标贴屏幕左缘/上缘）—— 必须原样使用，逐轴判断
  // 「非零才可用」会在贴左/贴顶的最后几像素处退化成合成值。
  // 仅当两轴都为 0（XWayland 下 OS 不下发绝对坐标）才用「窗口位置 + client 偏移」
  // 合成：合成值以窗口自身位置为输入，主进程按绝对锚点移动窗口时构成反馈回路
  // （贴边抖动/回弹），故只在拿不到原生坐标时兜底
  function absPoint(e) {
    var x = e.screenX
    var y = e.screenY
    var native = typeof x === 'number' && isFinite(x) && typeof y === 'number' && isFinite(y) && (x !== 0 || y !== 0)
    if (native) return { x: x, y: y }
    return { x: window.screenX + e.clientX, y: window.screenY + e.clientY }
  }
  function onDocPointerDown(e) {
    // 气泡展开时它可能盖住鲸鱼：这一击不能吞掉，要按「点鲸鱼」处理（推进泡泡序列）。
    // 旧实现直接 return，而 bubbleBox 的 click 只在点到 SVG 已绘制像素时才触发 ——
    // 点在气泡盒内的透明处两边都收不到，表现为「点第二下完全没反应」。
    if (e.target && e.target.closest && e.target.closest('.wp-menu-btn')) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!isWhaleHit(e)) return
    try { e.preventDefault() } catch (err) {}
    api.closeMenu() // 点击鲸鱼时主动收起设置窗口
    var abs0 = absPoint(e)
    drag = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      // 最近一次绝对坐标：movement=0 但绝对坐标仍变化（光标已贴物理边界、需要
      // 继续把窗口推出去）时照样上报一次，让主进程绝对锚点四边可达
      lastScreenX: abs0.x,
      lastScreenY: abs0.y,
    }
    try { e.target.setPointerCapture(e.pointerId) } catch (err) {}
    root.classList.add('wp-dragging')
    pressDown()
    setWidgetCursor('grabbing')
    // 附上「可见图形矩形」：主进程据此钳制，四边都能让鲸鱼本体贴到屏幕边
    // dragStart 失败不影响后续 pointerup 的点击判定（气泡照常弹出）
    api.dragStart(e.clientX, e.clientY, abs0.x, abs0.y, fishRect())
    // onDocPointerMove 是持久监听（启动时注册），不在此重复注册，
    // 否则拖动结束 removeEventListener 会把持久监听一并摘掉。
    document.addEventListener('pointerup', onDocPointerUp, true)
    document.addEventListener('pointercancel', onDocPointerCancel, true)
  }

  function onDocPointerMove(e) {
    lastPointerMoveAt = Date.now()
    if (drag && drag.active) {
      var mx = e.movementX
      var my = e.movementY
      if (typeof mx !== 'number' || !isFinite(mx)) mx = 0
      if (typeof my !== 'number' || !isFinite(my)) my = 0
      // 若 movement 为 0 但绝对坐标仍变化（光标已贴物理边界、需要继续把窗口推出去；
      // 窗口移动合成的回送事件不会改变真实光标位置），照样上报一次
      var absP = absPoint(e)
      var absChanged = absP.x !== drag.lastScreenX || absP.y !== drag.lastScreenY
      if (mx === 0 && my === 0 && !absChanged) return
      drag.lastScreenX = absP.x
      drag.lastScreenY = absP.y
      var dxc = e.clientX - drag.startX
      var dyc = e.clientY - drag.startY
      if (dxc * dxc + dyc * dyc >= CLICK_SQ || Math.abs(mx) + Math.abs(my) > 2) drag.moved = true
      // 逐事件上报：绝对坐标供主进程绝对锚点通道，增量供无绝对坐标时的备通道
      api.dragDelta(mx, my, e.clientX, e.clientY, absP.x, absP.y)
      return
    }
    // 悬停在可点击区域 → 显示菜单按钮 + 抓取光标（按键盒判定，避免滑向按钮时消失）
    var over = inClickable(e)
    menuBtn.classList.toggle('wp-menu-btn-visible', over)
    setWidgetCursor(over ? 'grab' : '')
  }

  async function onDocPointerUp(e) {
    document.removeEventListener('pointerup', onDocPointerUp, true)
    document.removeEventListener('pointercancel', onDocPointerCancel, true)
    if (!drag || !drag.active) return
    drag.active = false
    var clickAllowed = e.type === 'pointerup'
    pressUp()
    root.classList.remove('wp-dragging')
    setWidgetCursor('')
    if (clickAllowed && !drag.moved) {
      // 点击判定与「结束拖拽」解耦：dragEnd 失败/超时绝不能吞掉气泡。
      // 旧实现 await api.dragEnd() 后才 onWhaleTap()，一旦该 IPC 抛错或挂住，
      // 表现为「点鲸鱼完全没反应」（气泡不弹、也不刷新）。
      api.dragEnd().catch(function () {})
      onWhaleTap()
      refresh(true)
      return
    }
    await finishDrag()
  }

  async function onDocPointerCancel(e) {
    document.removeEventListener('pointerup', onDocPointerUp, true)
    document.removeEventListener('pointercancel', onDocPointerCancel, true)
    if (!drag || !drag.active) return
    drag.active = false
    pressUp()
    root.classList.remove('wp-dragging')
    setWidgetCursor('')
    await finishDrag()
  }

  async function finishDrag() {
    // 任一 IPC 失败都不应让松手后的定位/记忆位置整段中断
    var end = await api.dragEnd().catch(function () { return null })
    var bd = await api.getDisplayBounds().catch(function () { return null })
    var wa = await api.getWorkArea().catch(function () { return null })
    if (!end || !bd || !wa) return
    // 自由定位：只按「可见图形四边可贴屏幕边」钳制（与主进程引擎同一套规则）
    var fit = settlePos(Math.round(end.x), Math.round(end.y), bd, wa)
    var x = fit.x
    var y = fit.y
    var rp = await api.setWindowPos(x, y).catch(function () { return null })
    if (rp && isFinite(rp.x) && isFinite(rp.y)) { x = Math.round(rp.x); y = Math.round(rp.y); advancePos(x, y) }
    api.setConfig({ posX: x, posY: y })
  }

  // 鲸鱼/气泡/菜单按钮上的点击才会生效；透明区域（或不在鲸鱼上）的点按
  // 直接忽略（窗口始终接收事件，不做不可靠的 setIgnoreMouseEvents 穿透）。
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('pointermove', onDocPointerMove, true)
  document.addEventListener('contextmenu', function (e) {
    // 无边框窗口默认有 Chromium 右键菜单，先全局禁用
    try { e.preventDefault() } catch (err) {}
    if (isWhaleHit(e)) api.openMenu()
  })

  var widgetCursor = ''
  function setWidgetCursor(v) {
    if (v !== widgetCursor) {
      widgetCursor = v
      try { document.body.style.cursor = v } catch (err) {}
    }
  }

  // ------------------------------------------------------------- 按压/音效
  var SQUISH = 'scaleY(0.88) scaleX(1.05)'
  var pressAudio = null
  var releaseAudio = null
  var pressing = false
  var pressEnded = false
  var releasePlayed = false
  var releaseTimer = null

  function applySoundSet() {
    try {
      // v0.3.5：当前音效组可能是用户自定义组。自定义组通过 readAudio 取字节播放
      // （不走 file://，以便统一 MIME 并支持内置 wav 片段）。
      if (audioGroup && audioGroup !== 'duck' && audioGroup !== 'fx1') {
        applyCustomSoundGroup(audioGroup)
        return
      }
      var pressSrc = pressSound ? resolveImgPath(pressSound) : (audioGroup === 'fx1' ? '../assets/D1.mp3' : '../assets/Ya1.mp3')
      var releaseSrc = releaseSound ? resolveImgPath(releaseSound) : (audioGroup === 'fx1' ? '../assets/D2.mp3' : '../assets/Ya2.mp3')
      pressAudio = new Audio(pressSrc)
      pressAudio.preload = 'auto'
      pressAudio.volume = soundVol
      releaseAudio = new Audio(releaseSrc)
      releaseAudio.preload = 'auto'
      releaseAudio.volume = soundVol
    } catch (err) {}
  }

  // 自定义音效组：解析两个槽位后按需加载；'' = 显式静音（置 null，不发声）
  function applyCustomSoundGroup(groupId) {
    pressAudio = null
    releaseAudio = null
    if (!api.getAudio) return
    api.getAudio().then(function (res) {
      if (!res || !res.groups) return
      var g = null
      for (var i = 0; i < res.groups.length; i++) if (res.groups[i].id === groupId) g = res.groups[i]
      if (!g) return
      // 空串 = 显式静音 → 保持 null；null/未设置 → 回退内置小黄鸭
      var pFrag = g.press === '' ? '' : (g.press || 'ya1')
      var rFrag = g.release === '' ? '' : (g.release || 'ya2')
      if (pFrag) loadFragmentAudio(pFrag, function (a) { pressAudio = a })
      if (rFrag) loadFragmentAudio(rFrag, function (a) { releaseAudio = a })
    }).catch(function () {})
  }

  // 片段 → Audio 元素（data URL；内置片段由主进程按自带 MIME 下发）
  function loadFragmentAudio(fragId, cb) {
    api.readAudio(fragId).then(function (res) {
      if (!res || !res.ok) return
      try {
        var a = new Audio('data:' + res.mime + ';base64,' + res.base64)
        a.preload = 'auto'
        a.volume = soundVol
        cb(a)
      } catch (err) {}
    }).catch(function () {})
  }

  // ---------------------------------------------------------- 任务结束音
  // 上游用「每轮对话结束（turn/end）」触发；桌宠独立运行时没有对话事件流，
  // 因此以「余额下降被观测到」作为一次消费完成的近似信号（与记账模式同一依据）。
  // 语义与上游一致：默认关闭；开启后按 sel 播放单体 / 内置槽 / 整个音效组。
  var taskEnd = { on: false, sel: 'frag:exp_orb', pins: [] }
  var taskEndAudioCache = {}

  function applyTaskEnd(cfgObj) {
    if (!cfgObj || typeof cfgObj !== 'object') return
    taskEnd = {
      on: cfgObj.on === true,
      sel: typeof cfgObj.sel === 'string' ? cfgObj.sel : 'frag:exp_orb',
      pins: Array.isArray(cfgObj.pins) ? cfgObj.pins : [],
    }
  }

  function playTaskEndSound() {
    if (!taskEnd.on || !soundOn) return
    var sel = String(taskEnd.sel || '')
    if (sel.indexOf('grp:') === 0) {
      playGroupClick(sel.slice(4))
      return
    }
    if (sel.indexOf('frag:') === 0) {
      playFragment(sel.slice(5))
      return
    }
    if (sel.indexOf('preset:') === 0) {
      var parts = sel.split(':')
      if (parts.length >= 3) playFragment(parts[2] === 'release' ? (parts[1] === 'fx1' ? 'd2' : 'ya2') : (parts[1] === 'fx1' ? 'd1' : 'ya1'))
    }
  }

  function playFragment(fragId) {
    if (!fragId) return
    var cached = taskEndAudioCache[fragId]
    if (cached) {
      try { cached.currentTime = 0; cached.volume = soundVol; cached.play() } catch (err) {}
      return
    }
    loadFragmentAudio(fragId, function (a) {
      taskEndAudioCache[fragId] = a
      try { a.play() } catch (err) {}
    })
  }

  // 整个音效组当一次「点按」播放：先 press，结束后再 release。
  // 与上游 playTaskEndGroupClick 一致 —— 只空一个槽时**仍要**播放另一个，
  // 两个都空才静默返回（v729 修复的行为）。
  function playGroupClick(groupId) {
    if (!api.getAudio) return
    api.getAudio().then(function (res) {
      if (!res || !res.groups) return
      var g = null
      for (var i = 0; i < res.groups.length; i++) if (res.groups[i].id === groupId) g = res.groups[i]
      if (!g) return
      var pFrag = g.press === '' ? '' : (g.press || 'ya1')
      var rFrag = g.release === '' ? '' : (g.release || 'ya2')
      if (!pFrag && !rFrag) return // 两槽都空 → 静默
      if (!pFrag) { playFragment(rFrag); return }
      loadFragmentAudio(pFrag, function (pressA) {
        pressA.volume = soundVol
        pressA.onended = function () { if (rFrag) playFragment(rFrag) }
        try { pressA.play() } catch (err) { if (rFrag) playFragment(rFrag) }
      })
    }).catch(function () {})
  }

  function playPress() {
    if (!pressAudio || !soundOn) return
    try {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
      if (releaseAudio) {
        releaseAudio.pause()
        releaseAudio.currentTime = 0
      }
      pressEnded = false
      releasePlayed = false
      pressAudio.onended = function () {
        pressEnded = true
        if (!pressing && !releasePlayed) playRelease()
      }
      pressAudio.currentTime = 0
      var p = pressAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }

  function playRelease() {
    if (releasePlayed || !releaseAudio || !soundOn) return
    releasePlayed = true
    try {
      releaseAudio.currentTime = 0
      var p = releaseAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }

  function pressDown() {
    body.style.transform = SQUISH
    pressing = true
    playPress()
  }

  function pressUp() {
    body.style.transform = 'scaleY(1) scaleX(1)'
    pressing = false
    if (pressEnded) {
      playRelease()
      return
    }
    var durKnown = false
    var remainMs = 0
    try {
      var dur = pressAudio ? pressAudio.duration : 0
      if (isFinite(dur) && dur > 0) {
        durKnown = true
        remainMs = (dur - pressAudio.currentTime) * 1000
      }
    } catch (err) {}
    if (durKnown) {
      releaseTimer = setTimeout(function () {
        releaseTimer = null
        playRelease()
      }, Math.max(0, remainMs - 100))
    }
  }

  // ------------------------------------------------------------- 闲置半透明
  function checkIdle() {
    if (!idleFade || (drag && drag.active)) {
      root.classList.remove('wp-idle')
      return
    }
    var idle = Date.now() - lastPointerMoveAt > IDLE_MS
    root.classList.toggle('wp-idle', idle)
  }

  // ------------------------------------------------------------- 配置应用
  async function applyConfig(c, first) {
    if (!c) return
    peakMode = ['liangwen', 'qiangqiang'].includes(c.peakMode) ? c.peakMode : 'default'
    peakText = c.peakText !== false
    bubbleOn = c.bubbleOn !== false
    var bi = (typeof c.bubbleInterval === 'number' && isFinite(c.bubbleInterval)) ? Math.max(0, Math.round(c.bubbleInterval)) : 120
    bi = bi * 1000
    if (bi !== bubbleIntervalMs) {
      bubbleIntervalMs = bi
      if (bubbleIntervalTimer) { clearInterval(bubbleIntervalTimer); bubbleIntervalTimer = null }
      if (bubbleIntervalMs > 0) bubbleIntervalTimer = setInterval(function () { showRandomBubble() }, bubbleIntervalMs)
    }
    idleFade = c.idleFade !== false
    // 闲置不透明度（可调，0.2 - 1.0）
    var idleOp = (typeof c.idleOpacity === 'number' && isFinite(c.idleOpacity)) ? Math.min(1, Math.max(0.2, c.idleOpacity)) : 0.6
    root.style.setProperty('--wp-idle-opacity', String(idleOp))
    soundSet = c.soundSet === 'fx1' ? 'fx1' : 'duck'
    soundVol = typeof c.volume === 'number' ? c.volume : 0.8
    soundOn = soundVol > 0
    threshold = typeof c.lowBalanceThreshold === 'number' ? c.lowBalanceThreshold : 10
    alertImage = c.alertImage === true
    // v0.3.5：隐藏菜单按钮
    menuBtnHide = c.menuBtnHide === true
    applyMenuBtnHide()
    if (typeof c.audioGroup === 'string' && c.audioGroup) audioGroup = c.audioGroup
    if (typeof c.roleId === 'string' && c.roleId && c.roleId !== roleId) { roleId = c.roleId; loadRoleImage() }
    applyTaskEnd(c.taskEnd)
    if (typeof c.bubbleTapAdvance === 'boolean' && customBubble) customBubble.tapAdvance = c.bubbleTapAdvance
    if (typeof c.alertImgPath === 'string' && c.alertImgPath.trim()) alertImgPath = c.alertImgPath.trim()
    if (typeof c.mainImgPath === 'string' && c.mainImgPath.trim()) mainImgPath = c.mainImgPath.trim()
    // 播报表情：空串是合法值（= 不切换表情），所以不做「非空才写入」判断
    if (typeof c.dropImgPath === 'string') dropImgPath = c.dropImgPath.trim()
    if (typeof c.dropImage === 'boolean') dropImage = c.dropImage
    if (typeof c.dropImgHoldMs === 'number' && isFinite(c.dropImgHoldMs)) dropImgHoldMs = Math.max(0, Math.round(c.dropImgHoldMs))
    if (typeof c.bubbleTextOk === 'string' && c.bubbleTextOk.trim()) bubbleTextOk = c.bubbleTextOk.trim().slice(0, 20)
    if (typeof c.bubbleTextLow === 'string' && c.bubbleTextLow.trim()) bubbleTextLow = c.bubbleTextLow.trim().slice(0, 20)
    if (typeof c.textColorOk === 'string') textColorOk = /^#[0-9a-fA-F]{6}$/.test(c.textColorOk.trim()) ? c.textColorOk.trim() : ''
    if (typeof c.textColorLow === 'string') textColorLow = /^#[0-9a-fA-F]{6}$/.test(c.textColorLow.trim()) ? c.textColorLow.trim() : ''
    if (typeof c.peakTextOff === 'string') peakTextOff = c.peakTextOff.trim().slice(0, 12)
    if (typeof c.peakTextOn === 'string') peakTextOn = c.peakTextOn.trim().slice(0, 12)
    if (typeof c.pressSound === 'string') pressSound = c.pressSound.trim()
    if (typeof c.releaseSound === 'string') releaseSound = c.releaseSound.trim()
    var interval = Math.round((typeof c.refreshInterval === 'number' ? c.refreshInterval : 60) * 1000)
    if (interval !== refreshIntervalMs) {
      refreshIntervalMs = interval
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = setInterval(function () { refresh(false) }, refreshIntervalMs)
    }
    applySoundSet()
    if (typeof c.scale === 'number' && c.scale !== state.scale) {
      await setScale(c.scale)
    }
    updateHeroImage()
  }

  // ------------------------------------------------------------- 外部事件
  api.onConfigChanged(function (c) { applyConfig(c, false) })
  api.onCustomChanged(function (data) { applyCustom(data) })
  api.onRefresh(function () { refresh(true) })
  if (api.onBubbleChanged) {
    api.onBubbleChanged(function (data) {
      if (data && data.config) { customBubble = data.config; bubbleSeqIdx = 0 }
    })
  }

  // --------------------------------------------------- 自定义泡泡配置加载
  function applyBubbleConfig(data) {
    if (!data || !data.config) return
    customBubble = data.config
    if (data.limits) customBubbleLimits = data.limits
    if (data.gradients && Array.isArray(data.gradients)) {
      // 动态注册跑马灯配色（与菜单页共用同一份键名）
      for (var i = 0; i < data.gradients.length; i++) {
        root.classList.add('wp-has-rgb-' + data.gradients[i])
      }
    }
    bubbleSeqIdx = 0
  }

  // ------------------------------------------------------- 隐藏菜单按钮
  // 移植上游：开启后隐藏鲸鱼上的菜单按钮；桌面端右键鲸鱼唤出（再右键收起）。
  // 触屏设备即使未开启也允许长按约 1.5s 唤出（上游 issue #91 的修复）。
  var LONG_PRESS_MS = 1500
  var LONG_PRESS_SLOP = 10
  var longPressTimer = null
  var longPressStart = null
  var longPressFiredAt = 0

  function applyMenuBtnHide() {
    menuBtn.classList.toggle('wp-menu-btn-hidden', !!menuBtnHide)
    if (menuBtnHide) menuBtn.classList.remove('wp-menu-btn-visible')
  }

  function isTouchUI() {
    try {
      if (window.matchMedia && window.matchMedia('(hover: none)').matches) return true
      var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches
      return !!(coarse && navigator.maxTouchPoints > 0)
    } catch (err) { return false }
  }

  document.addEventListener('contextmenu', function (e) {
    if (!menuBtnHide) return
    if (!inClickable(e)) return
    e.preventDefault()
    openMenuSafe()
  }, true)

  document.addEventListener('touchstart', function (e) {
    if (!menuBtnHide && !isTouchUI()) return
    if (!inClickable(e)) return
    if (e.touches && e.touches.length === 1) {
      longPressStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      if (longPressTimer) clearTimeout(longPressTimer)
      longPressTimer = setTimeout(function () {
        longPressTimer = null
        longPressFiredAt = Date.now()
        try { if (navigator.vibrate) navigator.vibrate(10) } catch (err) {}
        openMenuSafe()
      }, LONG_PRESS_MS)
    }
  }, true)

  document.addEventListener('touchmove', function (e) {
    if (!longPressTimer || !longPressStart || !e.touches || !e.touches.length) return
    var dx = e.touches[0].clientX - longPressStart.x
    var dy = e.touches[0].clientY - longPressStart.y
    if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_SLOP) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }, true)

  function endLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
  }
  document.addEventListener('touchend', endLongPress, true)
  document.addEventListener('touchcancel', endLongPress, true)

  // ------------------------------------------------------------- 启动
  async function init() {
    var c = await api.getConfig()
    state.scale = c.scale || 1
    root.style.setProperty('--wp-base', (BASE_PX * state.scale) + 'px')
    // 屏幕水平/垂直中心（用于方向感知锚点）
    try {
      var bd = await api.getDisplayBounds()
      anchorCenterX = bd.x + bd.width / 2
      anchorCenterY = bd.y + bd.height / 2
    } catch (err) {}
    // 默认位置：右下角（等待 initPosition 覆盖为记忆位置）
    var wa0 = await api.getWorkArea()
    state.winW = Math.round(BASE_PX * state.scale)
    state.winH = state.winW
    advancePos(wa0.x + wa0.width - state.winW, wa0.y + wa0.height - state.winH)
    await api.resizeWindow(state.winW, state.winH)
    await initPosition()
    await applyConfig(c, true)
    setupHitTest()
    reportShape() // 按鲸鱼位置裁剪窗口 → 透明区域点击穿透
    api.getCustom().then(applyCustom).catch(function () {})
    if (api.getBubble) api.getBubble().then(applyBubbleConfig).catch(function () {})
    loadRoleImage()
    refresh(false)
    refreshTimer = setInterval(function () { refresh(false) }, refreshIntervalMs)
    idleCheckTimer = setInterval(checkIdle, 1500)
  }
  init().catch(function (err) { console.error('[whale-pet] init failed', err) })
})()
