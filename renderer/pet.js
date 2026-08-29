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
  var alertImgPath = 'assets/DSniang03.png'
  var bubbleTextOk = 'DeepSeek 余额'
  var bubbleTextLow = '余额预警'
  var textColorOk = ''
  var textColorLow = ''
  var peakTextOff = ''
  var peakTextOn = ''
  var pressSound = ''
  var releaseSound = ''
  var customGroups = null
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

  function restoreBubbleLines() {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    lastHintText = null
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

  // 主图/预警图二选一：预警换图开启且余额低于阈值 → 预警图；否则主图
  function updateHeroImage() {
    var low = alertImage && isLowBalance()
    var want = low ? resolveImgPath(alertImgPath) : resolveImgPath(mainImgPath)
    if (want && want !== currentImgSrc) {
      currentImgSrc = want
      img.src = want
      setupHitTest(want)
    }
    alertBadge.classList.toggle('wp-alert-badge-show', !!low)
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
        state.balance = nb
        state.currency = nc
        state.message = ''
        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
        state.isPeak = !!data.isPeak
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
    var cfg = await api.getConfig()
    var x, y
    if (typeof cfg.posX === 'number' && typeof cfg.posY === 'number') {
      x = clamp(cfg.posX, wa.x, wa.x + wa.width - state.winW)
      y = clamp(cfg.posY, wa.y, wa.y + wa.height - state.winH)
    } else {
      x = wa.x + wa.width - state.winW // 默认右下角
      y = wa.y + wa.height - state.winH
    }
    advancePos(x, y)
    await api.setWindowPos(x, y)
  }

  function advancePos(x, y) {
    state.posX = x
    state.posY = y
    updateAnchor()
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

  // ---------- 透明点击穿透：窗口裁剪为鲸鱼/气泡/按钮区域 ----------
  // 用布局盒（offset*，不含动画 transform）计算窗口内矩形，其余区域点击
  // 不落在窗口上 → 自然穿透到下方桌面/窗口。换图、开合气泡、缩放后重报。
  function reportShape() {
    try {
      var pad = 10
      var W = state.winW, H = state.winH
      var rects = []
      var p = function (x, y, w, h) {
        // 钳制到窗口范围内（shape 仅接受窗口内部区域）
        var x0 = Math.max(0, x), y0 = Math.max(0, y)
        var x1 = Math.min(W, x + w), y1 = Math.min(H, y + h)
        if (x1 > x0 && y1 > y0) rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
      }
      var w = img.offsetWidth
      if (w > 0) p(img.offsetLeft - pad, img.offsetTop - pad, w + pad * 2, img.offsetHeight + pad * 2)
      if (bubbleShown) {
        var b = bubbleBox.offsetWidth
        if (b > 0) p(bubbleBox.offsetLeft - pad, bubbleBox.offsetTop - pad, b + pad * 2, bubbleBox.offsetHeight + pad * 2)
      }
      var m = menuBtn.offsetWidth
      if (m > 0) p(menuBtn.offsetLeft - 4, menuBtn.offsetTop - 4, m + 8, menuBtn.offsetHeight + 8)
      if (flipped) {
        // 水平镜像：把矩形按窗口宽度翻转
        for (var i = 0; i < rects.length; i++) rects[i].x = W - (rects[i].x + rects[i].w)
      }
      api.setShape(rects)
    } catch (err) {}
  }

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
    root.style.setProperty('--wp-base', newW + 'px')
    state.winW = newW
    state.winH = newH
    var x = fixX - newW
    var y = fixY - newH
    var wa = await api.getWorkArea()
    x = clamp(x, wa.x, wa.x + wa.width - newW)
    y = clamp(y, wa.y, wa.y + wa.height - newH)
    advancePos(x, y)
    await api.resizeWindow(newW, newH)
    await api.setWindowPos(x, y)
    api.setConfig({ scale: next, posX: x, posY: y })
    reportShape()
  }

  // ------------------------------------------------------------- 命中测试
  var hitCanvas = null
  var hitReady = false
  function setupHitTest(src) {
    try {
      var probe = new Image()
      hitReady = false // 探针重载期间：命中测试放宽为「全命中」，保证可点击
      probe.onload = function () {
        try {
          hitCanvas = hitCanvas || document.createElement('canvas')
          hitCanvas.width = 610
          hitCanvas.height = 610
          hitCanvas.getContext('2d').drawImage(probe, 0, 0, 610, 610)
          hitReady = true
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
  // 拖拽：渲染进程只负责收集「原始位移增量」（e.movementX/Y）并上报主进程；
  // 窗口移动由主进程双通道引擎完成（光标权威 / 增量备通道，见 main.js 注释）。
  // 渲染进程不做任何窗口相对坐标的位移运算（client/screen 与窗口位置耦合，
  // 曾导致抽搐与飞移）。setPointerCapture 保证窗口外松手不掉拖。
  function onDocPointerDown(e) {
    if (e.target && e.target.closest && (e.target.closest('.wp-menu-btn') || e.target.closest('.wp-bubble'))) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!isWhaleHit(e)) return
    try { e.preventDefault() } catch (err) {}
    api.closeMenu() // 点击鲸鱼时主动收起设置窗口
    drag = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    }
    try { e.target.setPointerCapture(e.pointerId) } catch (err) {}
    root.classList.add('wp-dragging')
    pressDown()
    setWidgetCursor('grabbing')
    // 主进程以「真实绝对光标坐标」接管（渲染进程的 screenX/Y 由 OS 实时下发，
    // 不会出现主进程 getCursorScreenPoint 缓存冻结导致的贴边空气墙）
    api.dragStart(e.clientX, e.clientY, e.screenX, e.screenY)
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
      if (mx === 0 && my === 0) return // 指针未动（含窗口移动合成的回送事件）
      var dxc = e.clientX - drag.startX
      var dyc = e.clientY - drag.startY
      if (dxc * dxc + dyc * dyc >= CLICK_SQ || Math.abs(mx) + Math.abs(my) > 2) drag.moved = true
      // 逐事件上报（含绝对屏幕坐标，主进程以它为主通道；增量仅作备通道）
      api.dragDelta(mx, my, e.clientX, e.clientY, e.screenX, e.screenY)
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
      await api.dragEnd()
      showBubble()
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
    var end = await api.dragEnd() // {x, y} 主进程记录的最终窗口位置
    var bd = await api.getDisplayBounds()
    // 无吸附/无翻转：自由定位，仅钳制在显示器物理边界内（可贴到任意桌面边缘）
    var x = Math.round(end.x), y = Math.round(end.y)
    var w = state.winW, h = state.winH
    x = clamp(x, bd.x, bd.x + bd.width - w)
    y = clamp(y, bd.y, bd.y + bd.height - h)
    advancePos(x, y)
    await api.setWindowPos(x, y)
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
      var pressSrc = pressSound ? resolveImgPath(pressSound) : (soundSet === 'fx1' ? '../assets/D1.mp3' : '../assets/Ya1.mp3')
      var releaseSrc = releaseSound ? resolveImgPath(releaseSound) : (soundSet === 'fx1' ? '../assets/D2.mp3' : '../assets/Ya2.mp3')
      pressAudio = new Audio(pressSrc)
      pressAudio.preload = 'auto'
      pressAudio.volume = soundVol
      releaseAudio = new Audio(releaseSrc)
      releaseAudio.preload = 'auto'
      releaseAudio.volume = soundVol
    } catch (err) {}
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
    if (typeof c.alertImgPath === 'string' && c.alertImgPath.trim()) alertImgPath = c.alertImgPath.trim()
    if (typeof c.mainImgPath === 'string' && c.mainImgPath.trim()) mainImgPath = c.mainImgPath.trim()
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
    refresh(false)
    refreshTimer = setInterval(function () { refresh(false) }, refreshIntervalMs)
    idleCheckTimer = setInterval(checkIdle, 1500)
  }
  init().catch(function (err) { console.error('[whale-pet] init failed', err) })
})()
