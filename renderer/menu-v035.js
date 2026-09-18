/* ============================================================================
 * v0.3.5 新功能设置界面：自定义泡泡编辑器
 *
 * 与 menu.js 的分工：
 *   · menu.js 负责既有 Tab 的配置读写（window.whaleAPI.setConfig）
 *   · 本文件负责「泡泡」Tab，走专用 IPC：
 *       bubble:get / bubble:set   —— 泡泡配置独立成文件（bubble.json）
 *   · 「界面」Tab 里的「隐藏菜单按钮」开关也由本文件绑定
 *   · 与 lib/bubble.js 的约束保持一致（每行 6 模块 / 最多 6 行 / 图片独占一行）
 *
 * 交互设计要点（动画规范见 docs/design-v035.md）：
 *   · 序列条目支持原生拖拽排序（desktop）与长按 400ms 拖拽（触屏）
 *   · 拖拽中源条目降透明度 + 轻微缩小，落点条目显示虚线上边
 *   · 预览逐行错峰淡入（26ms/行），与鲸鱼窗口内的 70ms/行 保持同一节奏家族
 * ========================================================================== */
(function () {
  'use strict'
  var api = window.whaleAPI
  if (!api || !api.getBubble) return

  var $ = function (id) { return document.getElementById(id) }

  var MOD_MAX = 6
  var ROW_MAX = 6
  var GRADIENTS = []
  var MODULE_TYPES = [
    ['text', '文本'], ['link', '超链接'], ['random', '随机语句'],
    ['image', '图片/动图'], ['randimg', '随机图片'],
    ['balance', '余额'], ['today', '今日已用'], ['peak', '峰谷时段'],
  ]
  var IMG_TYPES = ['image', 'randimg']

  // 编辑器状态
  var cfg = { v: 1, items: [], lib: [], tapAdvance: false }
  var selected = -1
  var bubbleImgs = []
  var dirty = false

  function isImgMod(m) {
    return !!m && IMG_TYPES.indexOf(m.type) !== -1
  }

  // 行归组：与 lib/bubble.js rowsOf 同规则（图片独占行 + row 键合并 + 行数上限）
  function rowsOf(mods) {
    var out = []
    var cur = null
    for (var i = 0; i < (mods || []).length; i++) {
      var m = mods[i] || {}
      if (isImgMod(m)) { out.push([m]); cur = null; continue }
      var key = (typeof m.row === 'number' && isFinite(m.row) && Math.round(m.row) === m.row && m.row > 0) ? m.row : null
      if (cur && cur.key !== null && key === cur.key) { cur.row.push(m); continue }
      cur = { key: key, row: [m] }
      out.push(cur.row)
    }
    return out.slice(0, ROW_MAX)
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)) }

  function setNote(el, text, state) {
    if (!el) return
    el.textContent = text || ''
    if (state) el.dataset.state = state
  }

  function markDirty() {
    dirty = true
    setNote($('wm-bub-status'), '有未保存的修改', 'warn')
  }

  // ------------------------------------------------------------ 序列条目
  function itemLabel(it) {
    if (!it) return '默认余额泡'
    if (it.kind === 'random') return '随机台词泡'
    if (it.kind === 'choice') return '并列泡 A/B'
    if (it.kind === 'custom') {
      var n = (it.modules || []).length
      var rows = rowsOf(it.modules || []).length
      return '自定义泡（' + n + ' 模块 / ' + rows + ' 行）'
    }
    return '默认余额泡'
  }

  function itemKind(it) {
    if (!it) return '默认'
    if (it.kind === 'random') return '随机'
    if (it.kind === 'choice') return 'A/B'
    if (it.kind === 'custom') return '自定义'
    return '默认'
  }

  // 与 lib/bubble.js rowsOf 同规则（编辑器需自行分行以做行内编辑）

  function renderList() {
    var host = $('wm-bub-list')
    if (!host) return
    host.innerHTML = ''
    if (!cfg.items.length) {
      var empty = document.createElement('div')
      empty.className = 'wm-note wm-note-muted'
      empty.textContent = '（空：使用内置的余额气泡与随机台词）'
      host.appendChild(empty)
      return
    }
    for (var i = 0; i < cfg.items.length; i++) {
      ;(function (idx) {
        var it = cfg.items[idx]
        var row = document.createElement('div')
        row.className = 'wm-bub-item' + (idx === selected ? ' wm-bub-on' : '')
        row.setAttribute('draggable', 'true')
        row.dataset.idx = String(idx)

        var num = document.createElement('span')
        num.className = 'wm-bub-idx'
        num.textContent = String(idx + 1)
        row.appendChild(num)

        var name = document.createElement('span')
        name.className = 'wm-bub-name'
        name.textContent = itemLabel(it)
        row.appendChild(name)

        var kind = document.createElement('span')
        kind.className = 'wm-bub-kind'
        kind.textContent = itemKind(it)
        row.appendChild(kind)

        var tools = document.createElement('span')
        tools.className = 'wm-bub-tools'
        tools.appendChild(miniBtn('↑', '上移', function (e) {
          e.stopPropagation()
          if (idx === 0) return
          var t = cfg.items[idx - 1]; cfg.items[idx - 1] = cfg.items[idx]; cfg.items[idx] = t
          selected = idx - 1
          markDirty(); renderList(); renderEditor()
        }))
        tools.appendChild(miniBtn('↓', '下移', function (e) {
          e.stopPropagation()
          if (idx >= cfg.items.length - 1) return
          var t = cfg.items[idx + 1]; cfg.items[idx + 1] = cfg.items[idx]; cfg.items[idx] = t
          selected = idx + 1
          markDirty(); renderList(); renderEditor()
        }))
        // 「并列为 A/B」：把当前条目与下一条合成一个加权选择
        if (idx < cfg.items.length - 1 && it.kind !== 'choice') {
          tools.appendChild(miniBtn('A/B', '与下一条并列为加权选择', function (e) {
            e.stopPropagation()
            var a = cfg.items[idx]
            var b = cfg.items[idx + 1]
            cfg.items.splice(idx, 2, {
              kind: 'choice',
              options: [
                { w: 1, item: { kind: a.kind || 'normal', modules: a.modules } },
                { w: 1, item: { kind: b.kind || 'normal', modules: b.modules } },
              ],
            })
            markDirty(); renderList(); renderEditor()
          }))
        }
        tools.appendChild(miniBtn('✕', '删除这一项', function (e) {
          e.stopPropagation()
          cfg.items.splice(idx, 1)
          if (selected >= cfg.items.length) selected = cfg.items.length - 1
          markDirty(); renderList(); renderEditor()
        }))
        row.appendChild(tools)

        row.addEventListener('click', function () {
          selected = idx
          renderList()
          renderEditor()
        })
        bindReorder(row, idx)
        host.appendChild(row)
      })(i)
    }
  }

  function miniBtn(text, title, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'wm-mini'
    b.textContent = text
    b.title = title
    b.addEventListener('click', onClick)
    return b
  }

  // ---- 拖拽排序：桌面原生 DnD + 触屏长按 400ms 接管 ----
  var dragFrom = -1
  function bindReorder(row, idx) {
    row.addEventListener('dragstart', function (e) {
      dragFrom = idx
      row.classList.add('wm-bub-dragging')
      try { e.dataTransfer.setData('text/plain', String(idx)); e.dataTransfer.effectAllowed = 'move' } catch (err) {}
    })
    row.addEventListener('dragend', function () {
      dragFrom = -1
      row.classList.remove('wm-bub-dragging')
      var all = document.querySelectorAll('.wm-bub-item')
      for (var i = 0; i < all.length; i++) all[i].classList.remove('wm-bub-over')
    })
    row.addEventListener('dragover', function (e) {
      if (dragFrom < 0) return
      e.preventDefault()
      row.classList.add('wm-bub-over')
    })
    row.addEventListener('dragleave', function () { row.classList.remove('wm-bub-over') })
    row.addEventListener('drop', function (e) {
      e.preventDefault()
      row.classList.remove('wm-bub-over')
      if (dragFrom < 0 || dragFrom === idx) return
      var moved = cfg.items.splice(dragFrom, 1)[0]
      cfg.items.splice(idx, 0, moved)
      dragFrom = -1
      selected = idx
      markDirty(); renderList(); renderEditor()
    })

    // 触屏：长按 400ms 进入拖拽（上游移动端同款阈值）
    var lpTimer = null
    var touchActive = false
    row.addEventListener('touchstart', function () {
      touchActive = false
      if (lpTimer) clearTimeout(lpTimer)
      lpTimer = setTimeout(function () {
        lpTimer = null
        touchActive = true
        dragFrom = idx
        row.classList.add('wm-bub-dragging')
      }, 400)
    }, { passive: true })
    row.addEventListener('touchmove', function (e) {
      if (!touchActive || !e.touches || !e.touches.length) {
        if (lpTimer) { clearTimeout(lpTimer); lpTimer = null }
        return
      }
      e.preventDefault()
      var t = e.touches[0]
      var el = document.elementFromPoint(t.clientX, t.clientY)
      var all = document.querySelectorAll('.wm-bub-item')
      for (var i = 0; i < all.length; i++) all[i].classList.remove('wm-bub-over')
      while (el && el.className && String(el.className).indexOf('wm-bub-item') === -1) el = el.parentNode
      if (el && el.dataset && el.dataset.idx) el.classList.add('wm-bub-over')
    })
    row.addEventListener('touchend', function () {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null }
      row.classList.remove('wm-bub-dragging')
      if (!touchActive) return
      touchActive = false
      var over = document.querySelector('.wm-bub-item.wm-bub-over')
      if (over && over.dataset.idx) {
        var to = Number(over.dataset.idx)
        var moved = cfg.items.splice(dragFrom, 1)[0]
        cfg.items.splice(to, 0, moved)
        selected = to
        markDirty(); renderList(); renderEditor()
      }
      dragFrom = -1
    })
  }

  // ------------------------------------------------------------ 模块编辑器
  function currentModules() {
    var it = cfg.items[selected]
    if (!it || it.kind !== 'custom') return null
    if (!Array.isArray(it.modules)) it.modules = []
    return it.modules
  }

  function renderEditor() {
    var host = $('wm-bub-editor')
    if (!host) return
    host.innerHTML = ''
    var mods = currentModules()
    if (!mods) {
      var hint = document.createElement('div')
      hint.className = 'wm-note wm-note-muted'
      hint.textContent = '选中一个「自定义模块泡」后可编辑其模块；其他类型由内置逻辑渲染。'
      host.appendChild(hint)
      return
    }
    var rows = rowsOf(mods)
    // 约束提示
    var meta = document.createElement('div')
    meta.className = 'wm-note wm-note-muted'
    meta.textContent = '共 ' + rows.length + ' / ' + ROW_MAX + ' 行，每行最多 ' + MOD_MAX + ' 个模块；图片类模块独占一行且一个泡泡只能有一个。'
    host.appendChild(meta)

    if (!mods.length) {
      var e2 = document.createElement('div')
      e2.className = 'wm-note wm-note-muted'
      e2.textContent = '还没有模块，用下方按钮添加。'
      host.appendChild(e2)
    }

    // 按行渲染：同一行的模块放在同一张卡里
    var flatIdx = 0
    for (var r = 0; r < rows.length; r++) {
      var card = document.createElement('div')
      card.className = 'wm-mod-row'
      if (rows[r].length > 1) card.classList.add('wm-mod-samerow')
      if (isImgMod(rows[r][0])) card.classList.add('wm-mod-img-row')

      var badge = document.createElement('span')
      badge.className = 'wm-mod-badge'
      badge.textContent = '行 ' + (r + 1) + (isImgMod(rows[r][0]) ? ' · 图片独占' : '')
      card.appendChild(badge)

      for (var c = 0; c < rows[r].length; c++) {
        card.appendChild(moduleControls(mods[flatIdx], flatIdx))
        flatIdx++
      }

      // 行级操作：并入上一行 / 拆出新行
      var rowTools = document.createElement('div')
      rowTools.style.display = 'flex'
      rowTools.style.gap = '4px'
      if (r > 0 && !isImgMod(rows[r][0])) {
        rowTools.appendChild(miniBtn('并入上行', '把本行所有模块并入上一行', function () {
          var rowsNow = rowsOf(mods)
          if (rowsNow[r - 1].length + rowsNow[r].length > MOD_MAX) {
            setNote($('wm-bub-status'), '同一行最多 ' + MOD_MAX + ' 个模块，无法并入', 'error')
            return
          }
          if (isImgMod(rowsNow[r - 1][0])) {
            setNote($('wm-bub-status'), '上一行是图片行（独占一行），不能并入', 'error')
            return
          }
          var merged = rowsNow[r - 1].concat(rowsNow[r])
          rebuildFromRows(rowsNow.slice(0, r - 1).concat([merged], rowsNow.slice(r + 1)))
        }))
      }
      if (rows[r].length > 1) {
        rowTools.appendChild(miniBtn('拆出新行', '把本行最后一个模块另起一行', function () {
          var rowsNow = rowsOf(mods)
          if (rowsNow.length >= ROW_MAX) {
            setNote($('wm-bub-status'), '泡泡最多 ' + ROW_MAX + ' 行', 'error')
            return
          }
          var row = rowsNow[r]
          var moved = row.pop()
          rebuildFromRows(rowsNow.slice(0, r).concat([row.slice()], [[moved]], rowsNow.slice(r + 1)))
        }))
      }
      card.appendChild(rowTools)
      host.appendChild(card)
    }

    // 新建模块
    var add = document.createElement('div')
    add.style.display = 'flex'
    add.style.gap = '6px'
    add.style.alignItems = 'center'
    add.style.flexWrap = 'wrap'
    var sel = document.createElement('select')
    for (var t = 0; t < MODULE_TYPES.length; t++) {
      var o = document.createElement('option')
      o.value = MODULE_TYPES[t][0]
      o.textContent = MODULE_TYPES[t][1]
      sel.appendChild(o)
    }
    add.appendChild(sel)
    add.appendChild(miniBtn('＋ 添加模块', '追加到末尾（新起一行）', function () {
      var rowsNow = rowsOf(mods)
      if (mods.length >= ROW_MAX * MOD_MAX) return
      var type = sel.value
      if (isImgMod({ type: type })) {
        // 图片类：独占一行且全泡唯一
        for (var i = 0; i < mods.length; i++) {
          if (isImgMod(mods[i])) {
            setNote($('wm-bub-status'), '一个泡泡只能有一个图片类模块', 'error')
            return
          }
        }
        if (rowsNow.length >= ROW_MAX) { setNote($('wm-bub-status'), '泡泡最多 ' + ROW_MAX + ' 行', 'error'); return }
      }
      var m = newModule(type)
      // 追加到末尾：若末行未满且非图片，则并入末行，否则新起一行
      var lastRow = rowsNow[rowsNow.length - 1]
      if (lastRow && !isImgMod(m) && !isImgMod(lastRow[0]) && lastRow.length < MOD_MAX) {
        lastRow.push(m)
        rebuildFromRows(rowsNow)
      } else {
        rebuildFromRows(rowsNow.concat([[m]]))
      }
      markDirty(); renderEditor()
    }))
    host.appendChild(add)
  }

  // 用行数组重建 modules（同行写 row 键，单模块行清除键）—— 与上游 bubbleRowsFlat 一致
  function rebuildFromRows(rows) {
    var mods = currentModules()
    if (!mods) return
    var flat = []
    for (var r = 0; r < rows.length; r++) {
      var multi = rows[r].length > 1
      for (var i = 0; i < rows[r].length; i++) {
        var m = rows[r][i]
        if (multi) m.row = r + 1
        else delete m.row
        flat.push(m)
      }
    }
    mods.length = 0
    for (var k = 0; k < flat.length; k++) mods.push(flat[k])
    renderEditor()
  }

  function newModule(type) {
    if (type === 'text') return { type: 'text', text: '新文本', size: 6, bold: true }
    if (type === 'link') return { type: 'link', text: '链接文字', href: '', size: 4, color: '#2f5fb3', ul: true }
    if (type === 'random') return { type: 'random', size: 8, bold: true, lines: [{ t: '第一句台词', w: 1 }, { t: '第二句台词', w: 1 }] }
    if (type === 'image') return { type: 'image', imgId: '', size: 6, imgScale: 1 }
    if (type === 'randimg') return { type: 'randimg', imgs: [], size: 6, imgScale: 1 }
    if (type === 'balance') return { type: 'balance', tpl: 'DeepSeek 余额 {balance}', size: 8, bold: true }
    if (type === 'today') return { type: 'today', tpl: '今日已用 {today}', size: 4 }
    if (type === 'peak') return { type: 'peak', tpl: '当前 {status}', peakStyle: 'status', size: 5 }
    return { type: 'text', text: '新文本', size: 6 }
  }

  // 单个模块的控件组
  function moduleControls(m, flatIdx) {
    var wrap = document.createElement('span')
    // 用类而不是内联样式：需要 flex-wrap + min-width:0 才能在不撑破窗口的前提下
    // 自动换行（内联 inline-flex 会按内容宽度撑开，导致设置窗口横向溢出，
    // 右侧的「删除/上移」等按钮被切在窗口外）。
    wrap.className = 'wm-mod-ctl'

    var typeEl = document.createElement('span')
    typeEl.className = 'wm-mod-type'
    typeEl.textContent = typeName(m.type)
    wrap.appendChild(typeEl)

    // 文本类 / 模板类：内联文本框
    if (m.type === 'text' || m.type === 'link' || m.type === 'balance' || m.type === 'today' || m.type === 'peak') {
      var inp = document.createElement('input')
      inp.type = 'text'
      inp.className = 'wm-mod-text'
      inp.value = m.type === 'text' || m.type === 'link' ? (m.text || '') : (m.tpl || '')
      inp.placeholder = placeholderFor(m.type)
      inp.title = '内容里可以用的占位符见下方说明'
      inp.addEventListener('input', function () {
        if (m.type === 'text' || m.type === 'link') m.text = inp.value
        else m.tpl = inp.value
        markDirty(); schedulePreview()
      })
      wrap.appendChild(inp)
    }

    // 随机语句：显示条数 + 权重说明
    if (m.type === 'random') {
      wrap.appendChild(miniBtn('编辑语句(' + ((m.lines || []).length) + ')', '编辑随机语句与权重', function () {
        var lines = m.lines || (m.lines = [])
        var text = window.prompt('每行一句、格式「权重|台词」，例如：\n3|好模型...↓\n1|我去吃饭啦', lines.map(function (l) { return l.w + '|' + l.t }).join('\n'))
        if (text === null) return
        m.lines = text.split('\n').map(function (ln) {
          var p = ln.split('|')
          if (p.length > 1) return { w: Math.max(1, parseInt(p[0], 10) || 1), t: p.slice(1).join('|').trim() }
          return { w: 1, t: ln.trim() }
        }).filter(function (l) { return l.t })
        markDirty(); renderEditor(); schedulePreview()
      }))
    }

    // 图片类：选择图片 + 缩放
    if (isImgMod(m)) {
      wrap.appendChild(miniBtn('选择图片', '从泡泡图库中选择', function () {
        if (!bubbleImgs.length) { setNote($('wm-bub-status'), '泡泡图库为空，可先在「形象」页上传', 'error'); return }
        var names = bubbleImgs.map(function (im, i) { return (i + 1) + '. ' + im.name }).join('\n')
        var pick = window.prompt('选择图片编号：\n' + names, '1')
        if (pick === null) return
        var idx = Math.max(1, parseInt(pick, 10) || 1) - 1
        var im = bubbleImgs[idx]
        if (!im) return
        if (m.type === 'image') m.imgId = im.id
        else {
          var list = m.imgs || (m.imgs = [])
          list.push({ id: im.id, w: 1 })
        }
        markDirty(); renderEditor(); schedulePreview()
      }))
      if (m.type === 'randimg') {
        wrap.appendChild(miniBtn('(' + ((m.imgs || []).length) + '张)', '已加入的随机图片', function () {
          if (!(m.imgs || []).length) return
          var names = m.imgs.map(function (x, i) { return (i + 1) + '. ' + x.id + ' w=' + x.w }).join('\n')
          var del = window.prompt('输入要删除的编号（取消则不改动）：\n' + names, '')
          if (!del) return
          var i2 = parseInt(del, 10)
          if (i2 >= 1 && i2 <= m.imgs.length) { m.imgs.splice(i2 - 1, 1); markDirty(); renderEditor(); schedulePreview() }
        }))
      }
    }

    // 字号
    var sizeIn = document.createElement('input')
    sizeIn.type = 'number'
    sizeIn.className = 'wm-num-sm'
    sizeIn.min = '1'; sizeIn.max = '50'
    sizeIn.value = String(m.size || 6)
    sizeIn.title = '字号档位 1–50'
    sizeIn.addEventListener('input', function () {
      m.size = Math.max(1, Math.min(50, parseInt(sizeIn.value, 10) || 6))
      markDirty(); schedulePreview()
    })
    wrap.appendChild(sizeIn)

    // 字形开关
    wrap.appendChild(toggleBtn('B', '加粗', !!m.bold, function (v) { m.bold = v; markDirty(); schedulePreview() }))
    wrap.appendChild(toggleBtn('I', '斜体', !!m.italic, function (v) { m.italic = v; markDirty(); schedulePreview() }))
    wrap.appendChild(toggleBtn('U', '下划线', !!m.ul, function (v) { m.ul = v; markDirty(); schedulePreview() }))
    if (m.type === 'text' || m.type === 'random') {
      wrap.appendChild(toggleBtn('↩', '自动换行', !!m.wrap, function (v) { m.wrap = v; markDirty(); schedulePreview() }))
    }

    // 颜色（纯色）
    var col = document.createElement('input')
    col.type = 'color'
    col.className = 'wm-mod-color'
    col.value = /^#[0-9a-fA-F]{6}$/.test(m.color || '') ? m.color : '#536ba9'
    col.title = '文字颜色'
    col.addEventListener('input', function () { m.color = col.value; markDirty(); schedulePreview() })
    wrap.appendChild(col)

    // 跑马灯渐变
    if (GRADIENTS.length) {
      var rgbSel = document.createElement('select')
      var oNone = document.createElement('option')
      oNone.value = ''
      oNone.textContent = '无渐变'
      rgbSel.appendChild(oNone)
      for (var g = 0; g < GRADIENTS.length; g++) {
        var og = document.createElement('option')
        og.value = GRADIENTS[g]
        og.textContent = GRADIENTS[g]
        rgbSel.appendChild(og)
      }
      rgbSel.value = m.rgb || ''
      rgbSel.addEventListener('change', function () {
        if (rgbSel.value) m.rgb = rgbSel.value
        else delete m.rgb
        markDirty(); schedulePreview()
      })
      wrap.appendChild(rgbSel)
    }

    // 上移 / 下移 / 删除
    wrap.appendChild(miniBtn('←', '与前一个模块交换', function () {
      var mods = currentModules()
      if (!mods || flatIdx === 0) return
      var t = mods[flatIdx - 1]; mods[flatIdx - 1] = mods[flatIdx]; mods[flatIdx] = t
      markDirty(); renderEditor()
    }))
    wrap.appendChild(miniBtn('→', '与后一个模块交换', function () {
      var mods = currentModules()
      if (!mods || flatIdx >= mods.length - 1) return
      var t = mods[flatIdx + 1]; mods[flatIdx + 1] = mods[flatIdx]; mods[flatIdx] = t
      markDirty(); renderEditor()
    }))
    wrap.appendChild(miniBtn('✕', '删除这个模块', function () {
      var mods = currentModules()
      if (!mods) return
      mods.splice(flatIdx, 1)
      markDirty(); renderEditor()
    }))
    return wrap
  }

  function typeName(t) {
    for (var i = 0; i < MODULE_TYPES.length; i++) if (MODULE_TYPES[i][0] === t) return MODULE_TYPES[i][1]
    return t
  }

  function placeholderFor(t) {
    if (t === 'balance') return '例：DeepSeek 余额 {balance}'
    if (t === 'today') return '例：今日已用 {today}'
    if (t === 'peak') return '例：当前 {status}，距切换 {countdown}'
    return '文本内容'
  }

  function toggleBtn(label, title, on, onChange) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'wm-mini' + (on ? ' wm-mini-on' : '')
    b.textContent = label
    b.title = title
    b.addEventListener('click', function () {
      var next = b.className.indexOf('wm-mini-on') === -1
      b.classList.toggle('wm-mini-on', next)
      onChange(next)
    })
    return b
  }

  // ------------------------------------------------------------ 预览
  var previewTimer = null
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(renderPreview, 160)
  }

  // 取第 1 项渲染预览（choice 取第一个候选，避免每次都被随机结果干扰）
  function firstRenderable() {
    for (var i = 0; i < cfg.items.length; i++) {
      var it = cfg.items[i]
      if (!it) continue
      if (it.kind === 'custom' && Array.isArray(it.modules) && it.modules.length) return it
      if (it.kind === 'choice' && it.options && it.options.length) {
        var o = it.options[0].item
        if (o && o.kind === 'custom' && o.modules && o.modules.length) return o
      }
    }
    return null
  }

  function renderPreview() {
    var host = $('wm-bub-preview')
    if (!host) return
    host.innerHTML = ''
    var it = firstRenderable()
    if (!it) {
      var e = document.createElement('div')
      e.className = 'wm-note wm-note-muted'
      e.textContent = '没有可预览的自定义模块泡（默认余额泡与随机台词泡由鲸鱼窗口内置渲染）。'
      host.appendChild(e)
      return
    }
    var rows = rowsOf(it.modules)
    for (var r = 0; r < rows.length; r++) {
      var rowEl = document.createElement('div')
      rowEl.className = 'wm-pv-row'
      rowEl.style.animationDelay = (r * 26) + 'ms'
      for (var c = 0; c < rows[r].length; c++) rowEl.appendChild(previewMod(rows[r][c]))
      host.appendChild(rowEl)
    }
  }

  function previewMod(m) {
    if (isImgMod(m)) {
      var im = document.createElement('img')
      im.className = 'wm-pv-img'
      var id = m.type === 'image' ? m.imgId : ((m.imgs || [])[0] || {}).id
      var found = null
      for (var i = 0; i < bubbleImgs.length; i++) if (bubbleImgs[i].id === id) found = bubbleImgs[i]
      if (found) {
        api.readBubbleImg(found.id).then(function (res) {
          if (res && res.ok) im.src = 'data:' + res.mime + ';base64,' + res.base64
        }).catch(function () {})
      } else {
        im.alt = '（未选择图片）'
        im.style.fontSize = '11px'
        im.style.color = 'var(--wm-fg-subtle)'
      }
      return im
    }
    var el = document.createElement('span')
    el.className = 'wm-pv-mod'
    var text = ''
    if (m.type === 'text' || m.type === 'link') text = m.text || ''
    else if (m.type === 'random') text = ((m.lines || [])[0] || {}).t || '（随机语句）'
    else text = fillTemplate(m.tpl, previewValues())
    el.textContent = text
    var u = Math.round(40 + (Math.max(1, Math.min(50, m.size || 6)) - 1) * 200 / 49)
    el.style.fontSize = Math.max(9, Math.round(u * 0.16)) + 'px'
    if (m.bold) el.style.fontWeight = '800'
    if (m.italic) el.style.fontStyle = 'italic'
    if (m.ul) el.style.textDecoration = 'underline'
    if (m.color) el.style.color = m.color
    if (m.rgb) {
      el.style.backgroundImage = gradientCss(m.rgb)
      el.style.webkitBackgroundClip = 'text'
      el.style.backgroundClip = 'text'
      el.style.color = 'transparent'
      el.style.webkitTextFillColor = 'transparent'
    }
    return el
  }

  function previewValues() {
    return {
      balance: '¥ 128.40', today: '¥ 3.21', status: '空闲时段',
      countdown: '2小时15分后', cost: '¥ 0.42',
    }
  }

  function fillTemplate(tpl, values) {
    var s = String(tpl === undefined || tpl === null ? '' : tpl)
    return s.replace(/\{([a-z_]+)\}/g, function (all, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all
    })
  }

  function gradientCss(key) {
    var map = {
      rainbow: 'linear-gradient(90deg,#ffb4c8,#ffcdaa,#ffe1a5,#f5f0b4,#bef0d2)',
      candy: 'linear-gradient(90deg,#ff91aa,#ffaa82,#ffc36e,#f0dc73,#8cdcaf)',
      rouge: 'linear-gradient(90deg,#8c192d,#af233c,#781437,#a0284b)',
      bamboo: 'linear-gradient(90deg,#46b455,#5fc869,#37a546,#6ed778)',
      aurora: 'linear-gradient(90deg,#46f0c8,#5ac8ff,#788cff,#b478ff,#f08cff)',
      deepsea: 'linear-gradient(90deg,#145ab4,#1e8cd2,#28b4dc,#1478be)',
      sunset: 'linear-gradient(90deg,#ffb450,#ff825a,#ff5a6e,#dc5a96)',
      forest: 'linear-gradient(90deg,#1e643c,#3c8c50,#5ab45a,#8cc850)',
      champagne: 'linear-gradient(90deg,#dcb464,#f0cd82,#ffe1a0,#e6be6e)',
      lavender: 'linear-gradient(90deg,#b496ff,#c8aaff,#e6b4f0,#ffbedc)',
      mint: 'linear-gradient(90deg,#78e6b4,#96f0c8,#aaf0e6,#8cdcf0)',
      lava: 'linear-gradient(90deg,#ff3c28,#ff6e1e,#ffaa28,#ffd246)',
      galaxy: 'linear-gradient(90deg,#281e5a,#463282,#6e46aa,#a05abe)',
      ink: 'linear-gradient(90deg,#141414,#505050,#8c8c8c,#c8c8c8,#fafafa)',
      indigo: 'linear-gradient(90deg,#203170,#344c92,#4a66b4,#647ed2)',
    }
    return map[key] || map.indigo
  }

  // ------------------------------------------------------------ 保存/加载
  function loadBubble() {
    return api.getBubble().then(function (res) {
      if (!res || !res.ok) return
      cfg = res.config || cfg
      if (res.limits) { MOD_MAX = res.limits.modMax || MOD_MAX; ROW_MAX = res.limits.rowMax || ROW_MAX }
      if (res.gradients && res.gradients.length) GRADIENTS = res.gradients
      selected = cfg.items.length ? 0 : -1
      dirty = false
      setNote($('wm-bub-status'), '')
      var tap = $('wm-tapadvance')
      if (tap) tap.checked = cfg.tapAdvance === true
      renderList(); renderEditor(); renderPreview()
    })
  }

  function saveBubble() {
    cfg.tapAdvance = !!($('wm-tapadvance') && $('wm-tapadvance').checked)
    return api.setBubble(cfg).then(function (res) {
      if (res && res.ok) {
        cfg = res.config
        dirty = false
        setNote($('wm-bub-status'), '已保存', 'ok')
        renderList()
      } else {
        setNote($('wm-bub-status'), '保存失败：' + ((res && res.error) || '未知错误'), 'error')
      }
    }).catch(function (err) {
      setNote($('wm-bub-status'), '保存失败：' + err, 'error')
    })
  }

  function bindBubble() {
    var addN = $('wm-bub-add-normal')
    var addR = $('wm-bub-add-random')
    var addC = $('wm-bub-add-custom')
    if (addN) addN.addEventListener('click', function () {
      cfg.items.push({ kind: 'normal' })
      selected = cfg.items.length - 1
      markDirty(); renderList(); renderEditor(); renderPreview()
    })
    if (addR) addR.addEventListener('click', function () {
      cfg.items.push({ kind: 'random' })
      selected = cfg.items.length - 1
      markDirty(); renderList(); renderEditor(); renderPreview()
    })
    if (addC) addC.addEventListener('click', function () {
      // 新自定义泡给一个可直接用的起始内容（余额 + 今日已用）
      cfg.items.push({
        kind: 'custom',
        modules: [
          { type: 'balance', tpl: 'DeepSeek 余额 {balance}', size: 8, bold: true },
          { type: 'today', tpl: '今日已用 {today}', size: 4, color: '#9fb0d9' },
        ],
      })
      selected = cfg.items.length - 1
      markDirty(); renderList(); renderEditor(); renderPreview()
    })
    var tap = $('wm-tapadvance')
    if (tap) tap.addEventListener('change', markDirty)
    var save = $('wm-bub-save')
    if (save) save.addEventListener('click', saveBubble)
    var reload = $('wm-bub-reload')
    if (reload) reload.addEventListener('click', function () {
      if (dirty && !window.confirm('放弃未保存的修改？')) return
      loadBubble()
    })
    // 离开页面时若仍有未保存改动，给出提示（不阻塞）
    window.addEventListener('beforeunload', function (e) {
      if (!dirty) return
      e.preventDefault()
      e.returnValue = ''
    })
  }

  // ------------------------------------------------------------ 菜单按钮开关
  function bindMenuBtnHide() {
    var el = $('wm-menubtnhide')
    if (!el) return
    // 由 menu.js 的 fill() 负责回填值；这里只绑定写入
    el.addEventListener('change', function () {
      api.setConfig({ menuBtnHide: el.checked })
    })
  }

  // ------------------------------------------------------------ 泡泡图库
  function loadBubbleImgs() {
    if (!api.listBubbleImgs) return Promise.resolve()
    return api.listBubbleImgs().then(function (res) {
      if (res && res.ok) bubbleImgs = res.images || []
      renderPreview()
    }).catch(function () {})
  }

  // ------------------------------------------------------------ 启动
  function init() {
    bindBubble()
    bindMenuBtnHide()
    loadBubbleImgs().then(function () {
      return loadBubble()
    }).catch(function (err) { console.error('[whale-menu-v035] init failed', err) })
    // 设置窗口每次显示时刷新（可能被鲸鱼窗或外部改动过）
    window.addEventListener('focus', function () {
      if (!dirty) loadBubble()
      loadBubbleImgs()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()

  // 暴露给 menu.js：回填「隐藏菜单按钮」勾选状态
  window.__whaleV035 = {
    setMenuBtnHide: function (v) {
      var el = $('wm-menubtnhide')
      if (el) el.checked = v === true
    },
  }
})()
