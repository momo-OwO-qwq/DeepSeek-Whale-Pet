/* ============================================================================
 * 设置窗口（menu.html）—— 渲染进程逻辑
 * 所有控件修改都通过 whaleAPI.setConfig() 持久化；
 * 主进程会把 config:changed 广播给鲸鱼窗口（实时应用）。
 * ========================================================================== */
(function () {
  'use strict'
  var api = window.whaleAPI
  if (!api) return

  var $ = function (id) { return document.getElementById(id) }

  var els = {
    close: $('wm-close'),
    done: $('wm-done'),
    theme: $('wm-theme'),
    apiKey: $('wm-apikey'),
    apiKeyEye: $('wm-apikey-eye'),
    apiKeyNote: $('wm-apikey-note'),
    token: $('wm-token'),
    tokenEye: $('wm-token-eye'),
    usage: $('wm-usage'),
    scale: $('wm-scale'),
    scaleV: $('wm-scale-v'),
    sound: $('wm-sound'),
    vol: $('wm-vol'),
    volV: $('wm-vol-v'),
    peak: $('wm-peak'),
    peakText: $('wm-peaktext'),
    bubble: $('wm-bubble'),
    idleFade: $('wm-idlefade'),
    refresh: $('wm-refresh'),
    threshold: $('wm-threshold'),
    alertImage: $('wm-alertimage'),
    mainPick: $('wm-main-pick'),
    mainReset: $('wm-main-reset'),
    mainNote: $('wm-main-note'),
    alertPick: $('wm-alert-pick'),
    alertReset: $('wm-alert-reset'),
    alertNote: $('wm-alert-note'),
    textOk: $('wm-text-ok'),
    textLow: $('wm-text-low'),
    autostart: $('wm-autostart'),
    refreshNow: $('wm-refresh-now'),
  }

  var saveTimer = null
  function debounceSave(patch, ms) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () { api.setConfig(patch) }, ms || 150)
  }

  var currentCfg = null
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)')

  // 深色模式：theme = system | light | dark（跟随系统时监听系统变化）
  function applyTheme(cfg) {
    var dark = cfg && (cfg.theme === 'dark' || (cfg.theme !== 'light' && systemDark.matches))
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }
  function onSystemThemeChange() {
    if (currentCfg && (currentCfg.theme === 'system' || !currentCfg.theme)) applyTheme(currentCfg)
  }
  if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemThemeChange)
  else if (systemDark.addListener) systemDark.addListener(onSystemThemeChange)

  function imgPathNote(path) {
    if (!path) return ''
    if (path.indexOf('assets/') === 0) return '当前：' + path + '（内置素材）'
    var base = path.split('/').pop()
    return '当前：' + base + '（已复制到配置目录，随系统保留）'
  }

  function fill(cfg) {
    currentCfg = cfg
    applyTheme(cfg)
    els.theme.value = cfg.theme || 'system'
    els.apiKey.value = cfg.apiKey || ''
    els.token.value = cfg.platformToken || ''
    els.usage.value = cfg.usageMode || 'ledger'
    els.scale.value = String(cfg.scale || 1)
    els.scaleV.textContent = (cfg.scale || 1).toFixed(1)
    els.sound.value = cfg.soundSet || 'duck'
    els.vol.value = String(cfg.volume != null ? cfg.volume : 0.8)
    els.volV.textContent = Math.round((cfg.volume != null ? cfg.volume : 0.8) * 100) + '%'
    els.peak.value = cfg.peakMode || 'default'
    els.peakText.checked = cfg.peakText !== false
    els.bubble.checked = cfg.bubbleOn !== false
    els.idleFade.checked = cfg.idleFade !== false
    els.refresh.value = String(cfg.refreshInterval || 60)
    els.threshold.value = String(cfg.lowBalanceThreshold != null ? cfg.lowBalanceThreshold : 10)
    els.alertImage.checked = cfg.alertImage === true
    els.mainNote.textContent = imgPathNote(cfg.mainImgPath || 'assets/DSniang1.png')
    els.alertNote.textContent = imgPathNote(cfg.alertImgPath || 'assets/DSniang02.png')
    els.textOk.value = cfg.bubbleTextOk || 'DeepSeek 余额'
    els.textLow.value = cfg.bubbleTextLow || '余额预警'
    els.autostart.checked = !!cfg.autostart
    if (cfg.apiKeySource === 'env') {
      els.apiKeyNote.textContent = '当前使用环境变量 DEEPSEEK_API_KEY（此处可覆盖文件配置）'
      els.apiKeyNote.className = 'wm-note wm-note-ok'
      els.apiKey.disabled = true
    } else if (cfg.apiKey) {
      els.apiKeyNote.textContent = '已配置（保存在 ~/.config/whale-pet/config.json，权限 600）'
      els.apiKeyNote.className = 'wm-note wm-note-ok'
      els.apiKey.disabled = false
    } else {
      els.apiKeyNote.textContent = '未配置：点击鲸鱼将提示获取失败'
      els.apiKeyNote.className = 'wm-note wm-note-warn'
      els.apiKey.disabled = false
    }
  }

  async function reload() {
    fill(await api.getConfig())
  }

  // 任意输入框聚焦期间，跳过 config:changed 的字段回填（避免打断输入）
  function anyFocused() {
    try {
      var a = document.activeElement
      return !!(a && a.tagName && (a.tagName === 'INPUT' || a.tagName === 'SELECT'))
    } catch (err) { return false }
  }

  api.onConfigChanged(function (cfg) {
    if (!anyFocused()) fill(cfg)
  })

  // ---------- 关闭 ----------
  function closeWin() { api.closeMenu() }
  els.close.addEventListener('click', closeWin)
  els.done.addEventListener('click', closeWin)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeWin()
  })

  // ---------- API Key / 平台令牌 ----------
  function bindSecret(input, eye, patchKey) {
    eye.addEventListener('click', function () {
      input.type = input.type === 'password' ? 'text' : 'password'
      eye.textContent = input.type === 'password' ? '👁' : '🙈'
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { input.blur() }
    })
    input.addEventListener('change', function () {
      var patch = {}
      patch[patchKey] = input.value.trim()
      api.setConfig(patch).then(function () { reload() })
    })
  }
  bindSecret(els.apiKey, els.apiKeyEye, 'apiKey')
  bindSecret(els.token, els.tokenEye, 'platformToken')

  // ---------- 选择/开关 ----------
  els.theme.addEventListener('change', function () {
    api.setConfig({ theme: els.theme.value }).then(function (cfg) { applyTheme(cfg || { theme: els.theme.value }) })
  })
  els.usage.addEventListener('change', function () {
    api.setConfig({ usageMode: els.usage.value })
  })
  els.sound.addEventListener('change', function () {
    api.setConfig({ soundSet: els.sound.value })
  })
  els.peak.addEventListener('change', function () {
    api.setConfig({ peakMode: els.peak.value })
  })
  els.peakText.addEventListener('change', function () {
    api.setConfig({ peakText: els.peakText.checked })
  })
  els.bubble.addEventListener('change', function () {
    api.setConfig({ bubbleOn: els.bubble.checked })
  })
  els.idleFade.addEventListener('change', function () {
    api.setConfig({ idleFade: els.idleFade.checked })
  })
  els.autostart.addEventListener('change', function () {
    api.setConfig({ autostart: els.autostart.checked })
  })

  // ---------- 滑块（实时预览 + 防抖保存） ----------
  els.scale.addEventListener('input', function () {
    els.scaleV.textContent = Number(els.scale.value).toFixed(1)
    debounceSave({ scale: Number(els.scale.value) }, 200)
  })
  els.vol.addEventListener('input', function () {
    els.volV.textContent = Math.round(Number(els.vol.value) * 100) + '%'
    debounceSave({ volume: Number(els.vol.value) }, 200)
  })

  // ---------- 数字输入 ----------
  els.refresh.addEventListener('change', function () {
    var v = Math.round(Number(els.refresh.value) || 60)
    els.refresh.value = String(v)
    api.setConfig({ refreshInterval: v })
  })
  els.threshold.addEventListener('change', function () {
    var v = Number(els.threshold.value)
    if (!isFinite(v) || v < 0) v = 10
    els.threshold.value = String(v)
    api.setConfig({ lowBalanceThreshold: v })
  })
  els.alertImage.addEventListener('change', function () {
    api.setConfig({ alertImage: els.alertImage.checked })
  })

  // ---------- 主图 / 预警图上传（复制到配置目录，与源文件解耦）----------
  function bindImagePicker(pickBtn, resetBtn, kind, noteEl) {
    pickBtn.addEventListener('click', async function () {
      pickBtn.disabled = true
      try {
        var r = await api.pickImage(kind)
        if (r && r.ok) {
          noteEl.textContent = '已设置：' + r.path
          noteEl.className = 'wm-note wm-note-ok'
        } else if (r && !r.canceled) {
          noteEl.textContent = '选择失败：' + ((r && r.error) || '未知错误')
          noteEl.className = 'wm-note wm-note-warn'
        }
      } catch (err) {
        noteEl.textContent = '选择失败：' + String((err && err.message) || err)
        noteEl.className = 'wm-note wm-note-warn'
      } finally {
        pickBtn.disabled = false
      }
    })
    resetBtn.addEventListener('click', async function () {
      resetBtn.disabled = true
      try {
        await api.resetImage(kind)
        await reload()
      } finally {
        resetBtn.disabled = false
      }
    })
  }
  bindImagePicker(els.mainPick, els.mainReset, 'main', els.mainNote)
  bindImagePicker(els.alertPick, els.alertReset, 'alert', els.alertNote)

  // ---------- 气泡文案（限 20 字符，其余由 config 消毒/截断）----------
  els.textOk.addEventListener('change', function () {
    els.textOk.value = els.textOk.value.slice(0, 20)
    api.setConfig({ bubbleTextOk: els.textOk.value.trim() })
  })
  els.textLow.addEventListener('change', function () {
    els.textLow.value = els.textLow.value.slice(0, 20)
    api.setConfig({ bubbleTextLow: els.textLow.value.trim() })
  })

  // ---------- 立即刷新 ----------
  els.refreshNow.addEventListener('click', async function () {
    els.refreshNow.textContent = '刷新中…'
    els.refreshNow.disabled = true
    try {
      var r = await api.getBalance()
      els.refreshNow.textContent = r && r.ok ? '已刷新 ✓' : '失败 ✗'
      setTimeout(function () { els.refreshNow.textContent = '立即刷新'; els.refreshNow.disabled = false }, 1200)
    } catch (err) {
      els.refreshNow.textContent = '失败 ✗'
      setTimeout(function () { els.refreshNow.textContent = '立即刷新'; els.refreshNow.disabled = false }, 1200)
    }
  })

  reload().catch(function (err) { console.error('[menu] load failed', err) })
})()
