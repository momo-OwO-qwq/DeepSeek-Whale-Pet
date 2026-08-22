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

  var moodEl = document.createElement('div')
  moodEl.className = 'wp-mood'

  // 预警图片徽标（默认隐藏；达到预警额度时显示）
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
  body.appendChild(moodEl)
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
  var idleFade = true
  var refreshIntervalMs = 60000
  var threshold = 10
  var alertImage = false
  var alertImgPath = 'assets/DSniang02.png'
  var currentImgSrc = ''
  var lastPointerMoveAt = Date.now()

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
    var offText = '空闲时段'
    var peakTextStr = '高峰时段'
    if (peakMode === 'liangwen') { offText = '梁文谷'; peakTextStr = '梁文峰' }
    else if (peakMode === 'qiangqiang') { offText = '!?谷谷?!'; peakTextStr = '!?峰峰?!' }
    if (!peakText) {
      return [{ t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' }]
    }
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peak ? peakTextStr : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
      { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },
    ]
  }

  var RANDOM_GROUPS = [
    { w: 45, lines: buildGroup1 },
    { w: 7, lines: function () { return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓'])) } },
    { w: 7, lines: function () { return singleCenter('A', pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), '', true) } },
    { w: 10, lines: function () { return { gif: true } } },
    { w: 3, lines: function () { return singleCenter('A', pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), '', true) } },
    { w: 1, lines: function () { return singleCenter('B', '哦鲸鲸... ') } },
  ]

  function pickRandomLines() {
    var total = 0
    for (var i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w
    var r = Math.random() * total
    for (var i = 0; i < RANDOM_GROUPS.length; i++) {
      r -= RANDOM_GROUPS[i].w
      if (r < 0) return RANDOM_GROUPS[i].lines()
    }
    return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines()
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
    labelEl.textContent = 'DeepSeek 余额'
    labelEl.style.color = ''
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
    }
    updateMood()
  }

  function updateMood() {
    var mood = ''
    if (state.status === 'loading' && state.balance === null) mood = '💤'
    else if (state.status === 'error') mood = '😭'
    else if (isLowBalance()) mood = '🥺'
    if (moodEl.textContent !== mood) moodEl.textContent = mood
    moodEl.classList.toggle('wp-mood-show', !!mood)
    updateAlertImage()
  }

  function isLowBalance() {
    return state.status === 'ok' && state.balance !== null && isFinite(state.balance) &&
      state.balance >= 0 && state.balance < threshold
  }

  function resolveAlertImgPath(p) {
    var s = String(p || '').trim()
    if (!s) return '../assets/DSniang1.png'
    // http/https/file 或绝对路径原样使用（file:// 前缀由渲染器支持）
    if (/^(https?:|file:)/.test(s) || s.charAt(0) === '/') return s
    // 相对路径基于应用根目录：renderer/pet.html 位于 renderer/ 下，前缀 ../assets/
    return s.indexOf('assets/') === 0 ? '../' + s : '../' + s
  }

  // 预警换图：启用 && 余额低于阈值 → 切换为预警图片；恢复 → 换回默认鲸鱼
  function updateAlertImage() {
    var low = alertImage && isLowBalance()
    var want = low ? resolveAlertImgPath(alertImgPath) : '../assets/DSniang1.png'
    if (want !== currentImgSrc) {
      currentImgSrc = want
      img.src = want
      setupHitTest(want)
    }
    alertBadge.classList.toggle('wp-alert-badge-show', low)
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
    root.classList.toggle('wp-left', state.h === 'left')
  }

  async function setScale(v) {
    var next = Math.round(clamp(Number(v), MIN_SCALE, MAX_SCALE) * 10) / 10
    if (next === state.scale) return
    var oldW = state.winW, oldH = state.winH
    var newW = Math.round(BASE_PX * next)
    var newH = newW
    // 固定角：右吸附盯右下角，左吸附盯左下角（翻转后鲸鱼贴左）
    var fixX = state.h === 'left' ? state.posX : state.posX + oldW
    var fixY = state.posY + oldH
    state.scale = next
    root.style.setProperty('--wp-base', newW + 'px')
    state.winW = newW
    state.winH = newH
    var x = state.h === 'left' ? fixX : fixX - newW
    var y = fixY - newH
    var wa = await api.getWorkArea()
    x = clamp(x, wa.x, wa.x + wa.width - newW)
    y = clamp(y, wa.y, wa.y + wa.height - newH)
    advancePos(x, y)
    await api.resizeWindow(newW, newH)
    await api.setWindowPos(x, y)
    api.setConfig({ scale: next, posX: x, posY: y })
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
      if (state.h === 'left') lx = 610 - lx
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
      return data[3] > 10
    } catch (err) {
      return true
    }
  }

  // ------------------------------------------------------------- 指针交互
  function onDocPointerDown(e) {
    if (e.target && e.target.closest && (e.target.closest('.wp-menu-btn') || e.target.closest('.wp-bubble'))) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!isWhaleHit(e)) return
    try { e.preventDefault() } catch (err) {}
    api.closeMenu() // 点击鲸鱼时主动收起设置窗口
    var rect = root.getBoundingClientRect()
    drag = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX,
      offsetY: e.clientY,
      w: rect.width,
      h: rect.height,
      moved: false,
    }
    try { e.target.setPointerCapture(e.pointerId) } catch (err) {}
    root.classList.add('wp-dragging')
    pressDown()
    setWidgetCursor('grabbing')
    api.dragStart(drag.offsetX, drag.offsetY)
    // onDocPointerMove 是持久监听（启动时注册），不在此重复注册，
    // 否则拖动结束 removeEventListener 会把持久监听一并摘掉。
    document.addEventListener('pointerup', onDocPointerUp, true)
    document.addEventListener('pointercancel', onDocPointerCancel, true)
  }

  function onDocPointerMove(e) {
    lastPointerMoveAt = Date.now()
    if (drag && drag.active) {
      var dx = e.clientX - drag.startX
      var dy = e.clientY - drag.startY
      if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true
      return
    }
    // 悬停在鲸鱼上 → 显示菜单按钮 + 抓取光标
    var over = isWhaleHit(e)
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
      api.dragEnd()
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
    var end = await api.dragEnd() // {x, y} 当前窗口位置
    var wa = await api.getWorkArea()
    var x = end.x, y = end.y
    var w = state.winW, h = state.winH
    var cx = x + w / 2
    var cy = y + h / 2
    var moved = false
    if (cx < wa.x + wa.width / 4) { state.h = 'left'; x = wa.x; moved = true }
    else if (cx > wa.x + wa.width * 3 / 4) { state.h = 'right'; x = wa.x + wa.width - w; moved = true }
    else state.h = null
    if (cy < wa.y + wa.height / 4) { state.v = 'top'; y = wa.y; moved = true }
    else if (cy > wa.y + wa.height * 3 / 4) { state.v = 'bottom'; y = wa.y + wa.height - h; moved = true }
    else state.v = null
    x = clamp(x, wa.x, wa.x + wa.width - w)
    y = clamp(y, wa.y, wa.y + wa.height - h)
    advancePos(x, y)
    await api.setWindowPos(x, y)
    api.setConfig({ posX: x, posY: y, posH: state.h, posV: state.v })
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
      var pressSrc = soundSet === 'fx1' ? '../assets/D1.mp3' : '../assets/Ya1.mp3'
      var releaseSrc = soundSet === 'fx1' ? '../assets/D2.mp3' : '../assets/Ya2.mp3'
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
    idleFade = c.idleFade !== false
    soundSet = c.soundSet === 'fx1' ? 'fx1' : 'duck'
    soundVol = typeof c.volume === 'number' ? c.volume : 0.8
    soundOn = soundVol > 0
    threshold = typeof c.lowBalanceThreshold === 'number' ? c.lowBalanceThreshold : 10
    alertImage = c.alertImage === true
    if (typeof c.alertImgPath === 'string' && c.alertImgPath.trim()) alertImgPath = c.alertImgPath.trim()
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
    updateMood()
  }

  // ------------------------------------------------------------- 外部事件
  api.onConfigChanged(function (c) { applyConfig(c, false) })
  api.onRefresh(function () { refresh(true) })

  // ------------------------------------------------------------- 启动
  async function init() {
    var c = await api.getConfig()
    state.scale = c.scale || 1
    root.style.setProperty('--wp-base', (BASE_PX * state.scale) + 'px')
    // 默认位置：右下角（等待 initPosition 覆盖为记忆位置）
    var wa0 = await api.getWorkArea()
    state.winW = Math.round(BASE_PX * state.scale)
    state.winH = state.winW
    advancePos(wa0.x + wa0.width - state.winW, wa0.y + wa0.height - state.winH)
    await api.resizeWindow(state.winW, state.winH)
    await initPosition()
    await applyConfig(c, true)
    setupHitTest()
    refresh(false)
    refreshTimer = setInterval(function () { refresh(false) }, refreshIntervalMs)
    idleCheckTimer = setInterval(checkIdle, 1500)
  }
  init().catch(function (err) { console.error('[whale-pet] init failed', err) })
})()
