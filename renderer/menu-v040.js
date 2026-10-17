'use strict';
/* ===========================================================================
 * v0.4.0 设置页新增能力（对应上游「自定义泡泡框」与「音效四通道」）
 *   · 泡泡框：框库网格 + 真实缩略预览 + 左右版 + 内容安全区
 *   · 音效通道：按压 / 消耗 / 手动刷新 / 低余额，各自开关 + 音量 + 片段
 *   · 分组折叠：<div class="wm-group" data-collapsible> 的标题可点击收起
 *
 * 落地约定（与 menu.js / menu-v035.js 一致）：
 *   · 所有写操作都走 whaleAPI，失败时把错误写到就近的 .wm-note 上，不静默
 *   · 不做本地「假保存」：每次写成功都以主进程回传的载荷为准重新渲染
 * 说明：本文件只碰 v0.4.0 新增的 DOM（wm-frame-* / wm-ch-*），不改旧逻辑。
 * ========================================================================= */
(function () {
  var api = window.whaleAPI
  if (!api) return
  var $ = function (id) { return document.getElementById(id) }

  function setNote(el, text, state) {
    if (!el) return
    el.textContent = text || ''
    el.className = 'wm-note' + (state ? ' wm-note-' + state : '')
  }

  // ------------------------------------------------------------- 分组折叠
  function setupCollapsible() {
    var groups = document.querySelectorAll('.wm-group[data-collapsible]')
    for (var i = 0; i < groups.length; i++) {
      ;(function (g) {
        var title = g.querySelector('.wm-group-title')
        if (!title) return
        title.classList.add('wm-group-toggle')
        title.setAttribute('role', 'button')
        title.setAttribute('tabindex', '0')
        title.setAttribute('aria-expanded', 'true')
        var toggle = function () {
          var off = g.classList.toggle('wm-group-collapsed')
          title.setAttribute('aria-expanded', off ? 'false' : 'true')
        }
        title.addEventListener('click', toggle)
        title.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
        })
      })(groups[i])
    }
  }

  /* =========================================================================
   * 1. 泡泡框
   * ====================================================================== */
  var frame = { sel: 'classic', mirror: false, safe: null, frames: [], effective: null, busy: false }

  var BUILTIN_LABEL = {
    classic: '经典', round: '圆角', note: '便签', dashed: '虚线', glass: '毛玻璃'
  }

  function frameThumb(f) {
    var box = document.createElement('div')
    box.className = 'wm-frame-thumb'
    if (f.builtin) {
      box.classList.add('wm-thumb-' + f.kind)
      var card = document.createElement('div')
      card.className = 'wm-thumb-card'
      card.textContent = 'Aa'
      box.appendChild(card)
    } else {
      var img = document.createElement('img')
      img.alt = ''
      img.draggable = false
      box.appendChild(img)
      ;(function (id, el) {
        api.readFrame(id).then(function (res) {
          if (res && res.ok) el.src = 'data:' + res.mime + ';base64,' + res.base64
        }).catch(function () {})
      })(f.id, img)
    }
    return box
  }

  function renderFrameList() {
    var host = $('wm-frame-list')
    if (!host) return
    host.innerHTML = ''
    for (var i = 0; i < frame.frames.length; i++) {
      ;(function (f) {
        var item = document.createElement('button')
        item.type = 'button'
        item.className = 'wm-frame-item' + (f.id === frame.sel ? ' wm-frame-item-on' : '')
        item.title = f.name + (f.builtin ? '' : '（自定义）')
        item.appendChild(frameThumb(f))
        var name = document.createElement('span')
        name.className = 'wm-frame-name'
        name.textContent = f.builtin ? (BUILTIN_LABEL[f.kind] || f.name) : f.name
        item.appendChild(name)
        item.addEventListener('click', function () { selectFrame(f) })
        host.appendChild(item)
      })(frame.frames[i])
    }
    var del = $('wm-frame-delete')
    if (del) {
      var cur = frame.frames.filter(function (f) { return f.id === frame.sel })[0]
      del.disabled = !cur || !!cur.builtin
    }
    syncSafeSliders()
    var mirror = $('wm-frame-mirror')
    if (mirror) mirror.checked = frame.mirror === true
  }

  // 安全区滑块：跟随当前生效安全区（百分比）
  function syncSafeSliders() {
    var eff = frame.effective
    if (!eff || !eff.safe) return
    var s = eff.safe
    var map = [['wm-safe-x', s.x], ['wm-safe-y', s.y], ['wm-safe-w', s.w], ['wm-safe-h', s.h]]
    for (var i = 0; i < map.length; i++) {
      var el = $(map[i][0])
      if (!el) continue
      var v = Math.round(map[i][1] * 100)
      el.value = String(v)
      var lab = $(map[i][0] + '-v')
      if (lab) lab.textContent = v + '%'
    }
  }

  function applyFramePayload(res) {
    if (!res || !res.ok) return false
    frame.sel = res.sel
    frame.mirror = res.mirror === true
    frame.safe = res.safe || null
    frame.frames = Array.isArray(res.frames) ? res.frames : []
    frame.effective = res.effective || null
    renderFrameList()
    return true
  }

  function writeFrame(patch, okText) {
    if (frame.busy) return Promise.resolve(false)
    frame.busy = true
    var status = $('wm-frame-status')
    return api.setFrame(patch).then(function (res) {
      frame.busy = false
      if (!res || !res.ok) {
        setNote(status, '保存失败：' + ((res && res.error) || '未知错误'), 'warn')
        return false
      }
      applyFramePayload(res)
      setNote(status, okText || '已保存', 'ok')
      return true
    }).catch(function (err) {
      frame.busy = false
      setNote(status, '保存失败：' + String(err && err.message || err), 'warn')
      return false
    })
  }

  function selectFrame(f) {
    if (!f || f.id === frame.sel) return
    // 换框时清掉上一个框的安全区覆盖，回到新框自带的安全区
    writeFrame({ sel: f.id, safe: null }, '已切换到「' + f.name + '」')
  }

  var safeTimer = null
  function safePatchFromSliders() {
    var x = Number($('wm-safe-x').value) / 100
    var y = Number($('wm-safe-y').value) / 100
    var w = Number($('wm-safe-w').value) / 100
    var h = Number($('wm-safe-h').value) / 100
    return { x: x, y: y, w: w, h: h }
  }

  function bindFrame() {
    var list = $('wm-frame-list')
    if (!list) return

    var mirror = $('wm-frame-mirror')
    if (mirror) {
      mirror.addEventListener('change', function () {
        writeFrame({ mirror: mirror.checked }, mirror.checked ? '已开启镜像（尾巴换边）' : '已关闭镜像')
      })
    }

    ;['wm-safe-x', 'wm-safe-y', 'wm-safe-w', 'wm-safe-h'].forEach(function (id) {
      var el = $(id)
      if (!el) return
      el.addEventListener('input', function () {
        var lab = $(id + '-v')
        if (lab) lab.textContent = el.value + '%'
        if (safeTimer) clearTimeout(safeTimer)
        safeTimer = setTimeout(function () {
          safeTimer = null
          writeFrame({ safe: safePatchFromSliders() }, '安全区已保存')
        }, 220)
      })
    })

    var reset = $('wm-safe-reset')
    if (reset) reset.addEventListener('click', function () { writeFrame({ safe: null }, '已恢复框默认安全区') })

    var upload = $('wm-frame-upload')
    if (upload) {
      var picker = document.createElement('input')
      picker.type = 'file'
      picker.accept = 'image/png,image/gif'
      picker.style.display = 'none'
      document.body.appendChild(picker)
      upload.addEventListener('click', function () { picker.click() })
      picker.addEventListener('change', function () {
        var file = picker.files && picker.files[0]
        picker.value = ''
        if (!file) return
        if (file.size > 4 * 1024 * 1024) {
          setNote($('wm-frame-status'), '图片超过 4MB，未上传', 'warn')
          return
        }
        var reader = new FileReader()
        reader.onload = function () {
          var dataUrl = String(reader.result || '')
          var name = file.name.replace(/\.[^.]+$/, '').slice(0, 24) || '未命名框'
          setNote($('wm-frame-status'), '正在上传…')
          api.uploadFrame(name, dataUrl).then(function (res) {
            if (!res || !res.ok) {
              setNote($('wm-frame-status'), '上传失败：' + ((res && res.error) || '未知错误'), 'warn')
              return
            }
            applyFramePayload(res)
            setNote($('wm-frame-status'), '已上传并启用「' + name + '」', 'ok')
          }).catch(function (err) {
            setNote($('wm-frame-status'), '上传失败：' + String(err && err.message || err), 'warn')
          })
        }
        reader.onerror = function () { setNote($('wm-frame-status'), '读取文件失败', 'warn') }
        reader.readAsDataURL(file)
      })
    }

    var del = $('wm-frame-delete')
    if (del) {
      del.addEventListener('click', function () {
        var cur = frame.frames.filter(function (f) { return f.id === frame.sel })[0]
        if (!cur || cur.builtin) {
          setNote($('wm-frame-status'), '内置框不能删除', 'warn')
          return
        }
        if (!window.confirm('删除泡泡框「' + cur.name + '」？该操作不可撤销。')) return
        api.deleteFrame(cur.id).then(function (res) {
          if (!res || !res.ok) {
            setNote($('wm-frame-status'), '删除失败：' + ((res && res.error) || '未知错误'), 'warn')
            return
          }
          applyFramePayload(res)
          setNote($('wm-frame-status'), '已删除「' + cur.name + '」', 'ok')
        }).catch(function (err) {
          setNote($('wm-frame-status'), '删除失败：' + String(err && err.message || err), 'warn')
        })
      })
    }
  }

  function loadFrame() {
    return api.getFrame().then(applyFramePayload).catch(function () {})
  }

  /* =========================================================================
   * 2. 音效四通道
   * ====================================================================== */
  var CHANNELS = [
    { key: 'press', label: '按压 / 松手', hint: '按下与松开时的音效（沿用上面的音效组）' },
    { key: 'cost', label: '额度消耗', hint: '观测到余额下降时播放' },
    { key: 'ask', label: '手动刷新', hint: '点击鲸鱼手动刷新余额时播放' },
    { key: 'alert', label: '低余额提醒', hint: '刚进入低余额预警时播放一次' }
  ]

  var chState = { channels: null, fragments: [], busy: false }

  function fragOptions() {
    var list = chState.fragments || []
    var out = []
    for (var i = 0; i < list.length; i++) out.push({ value: 'frag:' + list[i].id, label: list[i].name })
    return out
  }

  function writeChannel(key, patch) {
    var next = JSON.parse(JSON.stringify(chState.channels || {}))
    next[key] = Object.assign({}, next[key] || {}, patch)
    return api.setConfig({ audioChannels: next }).then(function (cfg) {
      if (!cfg) {
        setNote($('wm-ch-status'), '保存失败：配置文件不可写', 'warn')
        return false
      }
      chState.channels = cfg.audioChannels || next
      renderChannels()
      setNote($('wm-ch-status'), '已保存', 'ok')
      return true
    }).catch(function (err) {
      setNote($('wm-ch-status'), '保存失败：' + String(err && err.message || err), 'warn')
      return false
    })
  }

  function renderChannels() {
    var host = $('wm-ch-list')
    if (!host) return
    host.innerHTML = ''
    var opts = fragOptions()
    for (var i = 0; i < CHANNELS.length; i++) {
      ;(function (def) {
        var ch = (chState.channels && chState.channels[def.key]) || { on: false, vol: 0.8, frag: '' }
        var row = document.createElement('div')
        row.className = 'wm-ch-row'

        var head = document.createElement('div')
        head.className = 'wm-ch-head'

        var label = document.createElement('label')
        label.className = 'wm-check'
        var cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = ch.on === true
        var box = document.createElement('span')
        box.className = 'wm-check-box'
        box.setAttribute('aria-hidden', 'true')
        var text = document.createElement('span')
        text.textContent = def.label
        label.appendChild(cb)
        label.appendChild(box)
        label.appendChild(text)
        head.appendChild(label)

        var volWrap = document.createElement('div')
        volWrap.className = 'wm-ch-vol'
        var range = document.createElement('input')
        range.type = 'range'
        range.className = 'wm-range'
        range.min = '0'
        range.max = '100'
        range.step = '5'
        range.value = String(Math.round((ch.vol || 0) * 100))
        range.disabled = !ch.on
        var val = document.createElement('span')
        val.className = 'wm-val'
        val.textContent = range.value + '%'
        volWrap.appendChild(range)
        volWrap.appendChild(val)
        head.appendChild(volWrap)
        row.appendChild(head)

        // 按压通道固定用音效组，不提供片段选择
        if (def.key !== 'press') {
          var sel = document.createElement('select')
          sel.className = 'wm-ch-frag'
          var empty = document.createElement('option')
          empty.value = ''
          empty.textContent = '（不发声）'
          sel.appendChild(empty)
          for (var k = 0; k < opts.length; k++) {
            var o = document.createElement('option')
            o.value = opts[k].value
            o.textContent = opts[k].label
            sel.appendChild(o)
          }
          sel.value = ch.frag || ''
          sel.addEventListener('change', function () { writeChannel(def.key, { frag: sel.value }) })
          row.appendChild(sel)
        }

        var hint = document.createElement('div')
        hint.className = 'wm-note wm-note-muted'
        hint.textContent = def.hint
        row.appendChild(hint)

        cb.addEventListener('change', function () {
          range.disabled = !cb.checked
          writeChannel(def.key, { on: cb.checked })
        })
        range.addEventListener('change', function () {
          val.textContent = range.value + '%'
          writeChannel(def.key, { vol: Number(range.value) / 100 })
        })
        range.addEventListener('input', function () { val.textContent = range.value + '%' })

        host.appendChild(row)
      })(CHANNELS[i])
    }
  }

  function loadChannels() {
    return Promise.all([api.getConfig(), api.getAudio().catch(function () { return null })]).then(function (res) {
      var cfg = res[0] || {}
      var audio = res[1] || {}
      chState.channels = cfg.audioChannels || null
      chState.fragments = Array.isArray(audio.fragments) ? audio.fragments : []
      renderChannels()
    }).catch(function () {})
  }

  /* =========================================================================
   * 3. 启动
   * ====================================================================== */
  function boot() {
    setupCollapsible()
    bindFrame()
    loadFrame()
    loadChannels()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
