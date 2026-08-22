/* ============================================================================
 * 设置窗口（menu.html，系统原生窗口 + Tab 标签页）—— 渲染进程逻辑
 * 所有控件修改都通过 whaleAPI.setConfig() 持久化；
 * 主进程把 config:changed 广播给鲸鱼窗口（实时应用）。
 * 主题：跟随系统（matchMedia 监听）/ 浅色 / 深色（与 nativeTheme 联动）。
 * ========================================================================== */
(function () {
  'use strict'
  var api = window.whaleAPI
  if (!api) return

  var $ = function (id) { return document.getElementById(id) }

  var els = {
    done: $('wm-done'),
    theme: $('wm-theme'),
    apiKey: $('wm-apikey'), apiKeyEye: $('wm-apikey-eye'), apiKeyNote: $('wm-apikey-note'),
    token: $('wm-token'), tokenEye: $('wm-token-eye'),
    usage: $('wm-usage'), refresh: $('wm-refresh'), threshold: $('wm-threshold'), autostart: $('wm-autostart'),
    bubble: $('wm-bubble'), idleFade: $('wm-idlefade'),
    scale: $('wm-scale'), scaleV: $('wm-scale-v'),
    peak: $('wm-peak'), peakText: $('wm-peaktext'), peakOff: $('wm-peak-off'), peakOn: $('wm-peak-on'),
    textOk: $('wm-text-ok'), textLow: $('wm-text-low'),
    colorOk: $('wm-color-ok'), colorLow: $('wm-color-low'),
    colorOkReset: $('wm-color-ok-reset'), colorLowReset: $('wm-color-low-reset'),
    sound: $('wm-sound'), vol: $('wm-vol'), volV: $('wm-vol-v'),
    pressPick: $('wm-press-pick'), pressReset: $('wm-press-reset'),
    releasePick: $('wm-release-pick'), releaseReset: $('wm-release-reset'),
    soundNote: $('wm-sound-note'),
    alertImage: $('wm-alertimage'),
    alertAvail: $('wm-alert-avail'),
    mainPick: $('wm-main-pick'), mainReset: $('wm-main-reset'), mainNote: $('wm-main-note'),
    alertPick: $('wm-alert-pick'), alertReset: $('wm-alert-reset'), alertNote: $('wm-alert-note'),
    customReload: $('wm-custom-reload'), customOpen: $('wm-custom-open'), customNote: $('wm-custom-note'),
    configOpen: $('wm-config-open'),
    usageOpen: $('wm-usage-open'),
    soundsOpen: $('wm-sounds-open'),
    imagesOpen: $('wm-images-open'),
    refreshNow: $('wm-refresh-now'),
  }

  // ---------- Tab 切换 ----------
  var tabs = document.querySelectorAll('.wm-tab')
  function switchTab(page) {
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-page') === page
      tabs[i].classList.toggle('wm-tab-on', on)
      var el = $('page-' + page)
      for (var j = 0; j < tabs.length; j++) {
        $('page-' + tabs[j].getAttribute('data-page')).hidden = true
      }
      if (el) el.hidden = false
    }
  }
  for (var i = 0; i < tabs.length; i++) {
    (function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-page')) })
    })(tabs[i])
  }
  switchTab('account')

  var saveTimer = null
  function debounceSave(patch, ms) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(function () { api.setConfig(patch) }, ms || 150)
  }

  // ---------- 主题（跟随系统） ----------
  var currentCfg = null
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)')
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
    if (!path) return '未提供（无默认预警图，可上传）'
    if (path.indexOf('assets/') === 0) return path + '（内置素材）'
    return path.split('/').pop() + '（已复制到配置目录）'
  }

  function fill(cfg) {
    currentCfg = cfg
    applyTheme(cfg)
    els.theme.value = cfg.theme || 'system'
    els.apiKey.value = cfg.apiKey || ''
    els.token.value = cfg.platformToken || ''
    els.usage.value = cfg.usageMode || 'ledger'
    els.refresh.value = String(cfg.refreshInterval || 60)
    els.threshold.value = String(cfg.lowBalanceThreshold != null ? cfg.lowBalanceThreshold : 10)
    els.autostart.checked = !!cfg.autostart
    els.bubble.checked = cfg.bubbleOn !== false
    els.idleFade.checked = cfg.idleFade !== false
    els.scale.value = String(cfg.scale || 1)
    els.scaleV.textContent = (cfg.scale || 1).toFixed(1)
    els.peak.value = cfg.peakMode || 'default'
    els.peakText.checked = cfg.peakText !== false
    els.peakOff.value = cfg.peakTextOff || ''
    els.peakOn.value = cfg.peakTextOn || ''
    els.textOk.value = cfg.bubbleTextOk || 'DeepSeek 余额'
    els.textLow.value = cfg.bubbleTextLow || '余额预警'
    els.colorOk.value = /^#[0-9a-fA-F]{6}$/.test(cfg.textColorOk || '') ? cfg.textColorOk : '#536ba9'
    els.colorLow.value = /^#[0-9a-fA-F]{6}$/.test(cfg.textColorLow || '') ? cfg.textColorLow : '#e0433f'
    els.sound.value = cfg.soundSet || 'duck'
    els.vol.value = String(cfg.volume != null ? cfg.volume : 0.8)
    els.volV.textContent = Math.round((cfg.volume != null ? cfg.volume : 0.8) * 100) + '%'
    els.alertImage.checked = cfg.alertImage === true
    els.mainNote.textContent = '主图：' + imgPathNote(cfg.mainImgPath || 'assets/DSniang1.png')
    els.alertNote.textContent = '预警图：' + imgPathNote(cfg.alertImgPath || '') + '（与主图独立）'
    if (cfg.alertImgPath) {
      els.alertAvail.textContent = '预警换图：余额低于阈值时自动切换为预警图'
      els.alertAvail.className = 'wm-note wm-note-ok'
      els.alertImage.disabled = false
    } else {
      els.alertAvail.textContent = '未提供默认预警图（无 assets/DSniang03.png）：开启预警换图需先在下方上传预警图。'
      els.alertAvail.className = 'wm-note wm-note-warn'
    }
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
  els.done.addEventListener('click', closeWin)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeWin()
  })

  // ---------- API Key / 平台令牌 ----------
  function bindSecret(input, eye, patchKey) {
    eye.addEventListener('click', function () {
      input.type = input.type === 'password' ? 'text' : 'password'
      eye.textContent = input.type === 'password' ? '显示' : '隐藏'
    })
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') input.blur()
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
  els.usage.addEventListener('change', function () { api.setConfig({ usageMode: els.usage.value }) })
  els.sound.addEventListener('change', function () { api.setConfig({ soundSet: els.sound.value }) })
  els.peak.addEventListener('change', function () { api.setConfig({ peakMode: els.peak.value }) })
  els.peakText.addEventListener('change', function () { api.setConfig({ peakText: els.peakText.checked }) })
  els.bubble.addEventListener('change', function () { api.setConfig({ bubbleOn: els.bubble.checked }) })
  els.idleFade.addEventListener('change', function () { api.setConfig({ idleFade: els.idleFade.checked }) })
  els.autostart.addEventListener('change', function () { api.setConfig({ autostart: els.autostart.checked }) })
  els.alertImage.addEventListener('change', function () { api.setConfig({ alertImage: els.alertImage.checked }) })

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

  // ---------- 峰谷自定义文案（留空 = 用内置/峰谷模式） ----------
  els.peakOff.addEventListener('change', function () {
    els.peakOff.value = els.peakOff.value.slice(0, 12)
    api.setConfig({ peakTextOff: els.peakOff.value.trim() })
  })
  els.peakOn.addEventListener('change', function () {
    els.peakOn.value = els.peakOn.value.slice(0, 12)
    api.setConfig({ peakTextOn: els.peakOn.value.trim() })
  })

  // ---------- 气泡文案 + 颜色 ----------
  els.textOk.addEventListener('change', function () {
    els.textOk.value = els.textOk.value.slice(0, 20)
    api.setConfig({ bubbleTextOk: els.textOk.value.trim() })
  })
  els.textLow.addEventListener('change', function () {
    els.textLow.value = els.textLow.value.slice(0, 20)
    api.setConfig({ bubbleTextLow: els.textLow.value.trim() })
  })
  els.colorOk.addEventListener('input', function () {
    api.setConfig({ textColorOk: els.colorOk.value })
  })
  els.colorLow.addEventListener('input', function () {
    api.setConfig({ textColorLow: els.colorLow.value })
  })
  els.colorOkReset.addEventListener('click', function () {
    api.setConfig({ textColorOk: '' }).then(function () { reload() })
  })
  els.colorLowReset.addEventListener('click', function () {
    api.setConfig({ textColorLow: '' }).then(function () { reload() })
  })

  // ---------- 主图 / 预警图 上传 ----------
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
      try { await api.resetImage(kind); await reload() } finally { resetBtn.disabled = false }
    })
  }
  bindImagePicker(els.mainPick, els.mainReset, 'main', els.mainNote)
  bindImagePicker(els.alertPick, els.alertReset, 'alert', els.alertNote)

  // ---------- 自定义音效（按压/松手） ----------
  function bindSoundPicker(pickBtn, resetBtn, which) {
    pickBtn.addEventListener('click', async function () {
      pickBtn.disabled = true
      try {
        var r = await api.pickSound(which)
        if (r && r.ok) {
          els.soundNote.textContent = (which === 'release' ? '松手' : '按压') + '音效已设置：' + r.path
          els.soundNote.className = 'wm-note wm-note-ok'
        } else if (r && !r.canceled) {
          els.soundNote.textContent = '选择失败：' + ((r && r.error) || '未知错误')
          els.soundNote.className = 'wm-note wm-note-warn'
        }
      } catch (err) {
        els.soundNote.textContent = '选择失败：' + String((err && err.message) || err)
        els.soundNote.className = 'wm-note wm-note-warn'
      } finally {
        pickBtn.disabled = false
      }
    })
    resetBtn.addEventListener('click', async function () {
      resetBtn.disabled = true
      try { await api.resetSound(which); await reload() } finally { resetBtn.disabled = false }
    })
  }
  bindSoundPicker(els.pressPick, els.pressReset, 'press')
  bindSoundPicker(els.releasePick, els.releaseReset, 'release')

  // ---------- 随机台词池（lines.json） ----------
  els.customReload.addEventListener('click', async function () {
    els.customReload.disabled = true
    try {
      var d = await api.reloadCustom()
      var groups = d && d.groups ? d.groups.length : 0
      var n = 0
      for (var g of (d && d.groups ? d.groups : [])) if (g.lines) n += g.lines.length
      els.customNote.textContent = (groups > 0 ? '已载入 ' + groups + ' 组（' + n + ' 条台词' + (d.gif ? ' + 自定义动图' : '') + '）' : '无有效配置')
      els.customNote.className = 'wm-note ' + (groups > 0 ? 'wm-note-ok' : '')
    } finally {
      els.customReload.disabled = false
    }
  })

  // ---------- 打开文件/目录（用系统默认程序；引用配置内路径） ----------
  function bindOpen(btn, getPath) {
    if (!btn) return
    btn.addEventListener('click', async function () {
      btn.disabled = true
      try { await api.openPath(getPath()) } finally { btn.disabled = false }
    })
  }
  bindOpen(els.customOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.lines) || '' })
  bindOpen(els.configOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.config) || '' })
  bindOpen(els.usageOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.usage) || '' })
  bindOpen(els.soundsOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.sounds) || '' })
  bindOpen(els.imagesOpen, function () { return (currentCfg && currentCfg.paths && currentCfg.paths.images) || '' })

  // ---------- 立即刷新 ----------
  els.refreshNow.addEventListener('click', async function () {
    els.refreshNow.textContent = '刷新中...'
    els.refreshNow.disabled = true
    try {
      var r = await api.getBalance()
      els.refreshNow.textContent = r && r.ok ? '已刷新' : '失败（检查 API Key）'
    } catch (err) {
      els.refreshNow.textContent = '失败'
    }
    setTimeout(function () { els.refreshNow.textContent = '立即刷新余额'; els.refreshNow.disabled = false }, 1200)
  })

  reload().catch(function (err) { console.error('[menu] load failed', err) })
})()
