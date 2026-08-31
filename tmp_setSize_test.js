'use strict'
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 320, height: 320, transparent: true, frame: false, show: false })
  await new Promise(r => setTimeout(r, 600))
  const b0 = win.getBounds()
  // 显示后再试（某些 WM 对未显示窗口的 setSize 忽略）
  win.show()
  await new Promise(r => setTimeout(r, 800))
  const bS = win.getBounds()
  win.setSize(160, 160)
  await new Promise(r => setTimeout(r, 1000))
  const b1 = win.getBounds()
  console.log('init ' + b0.width + 'x' + b0.height + ' after show ' + bS.width + 'x' + bS.height + ' after setSize(160) ' + b1.width + 'x' + b1.height)
  app.exit(0)
})