# 设计文档 —— DeepSeek 余额小鲸鱼桌宠（Linux 独立版）

> 版本 v1.0 · 基于原版 DSH 插件 v0.2.8 核心功能移植
> 参考：MeteorNOX/DeepSeek-Balance-Whale-Widget（DSH Web 挂件）、deepseek-whale-pet（Electron 版）
> 本文档记录架构决策与关键实现，代码即文档；修改时请同步更新对应小节。

---

## 1. 设计目标

将 DSH Web 插件版「余额小鲸鱼」改造成 **Linux 桌面独立桌宠**，脱离 DSH / 浏览器：

| 目标 | 验收 |
|---|---|
| 独立运行 | 不依赖 DSH、浏览器、任何凭证服务；`npm start` 即用 |
| 透明置顶 | 鲸鱼浮动于桌面，无边框无阴影，始终置顶 |
| 点击可靠 | 真实鼠标点击鲸鱼必然响应（气泡/刷新/拖拽），不依赖 OS 级穿透 |
| 余额监控 | 60s 自动刷新 + 点击手动；数字滚动动画；失败沿用最近余额 |
| 今日已用 | 记账模式（免令牌）/ 令牌模式（峰谷定价）与原版一致 |
| 桌宠交互 | 自由拖拽、按压 Q 弹、音效、随机台词、汉堡菜单 |
| 桌宠动效 | 呼吸、闲置半透明、低余额提醒、情绪表情 |
| 系统集成 | 托盘、全局热键、开机自启、单实例、系统通知 |
| 配置持久化 | `~/.config/whale-pet/`（config.json + usage.json，密钥 0600） |

## 2. 技术选型

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. Electron** | 透明置顶窗口原生支持；可直接移植原版 JS 逻辑；托盘/热键/自启/通知成熟；单实例 | 体积 ~100MB | ✅ **采用** |
| B. GNOME Shell 扩展 (GJS) | 原生集成、资源低 | 仅 GNOME；调试需重启 Shell；动效门槛高 | 备选 |
| C. Python + GTK4 | 轻量、跨桌面 | 透明置顶/动效需手写帧循环；无现成托盘+热键栈 | 备选 |

选 A 的决定性理由：原版挂件本身就是 **Web UI + Node 宿主逻辑** 的结构（`WIDGET_JS` + 宿主侧 `ctx.webServer`），Electron 的「主进程 Node + 渲染进程 Chromium」恰好一一对应，可以实现 **近乎 1:1 的移植**，把产品风险压到最低——核心余额/记账/UI 逻辑全部经单元测试与像素级冒烟验证。

## 3. 架构总览

```
┌────────────────────────── Electron 主进程 (Node) ─────────────────────────┐
│ main.js                                                                    │
│  ├── 窗口：pet（透明置顶桌宠）/ menu（透明设置弹窗）                        │
│  ├── 托盘 / 全局热键 / 单实例 / XDG 自启 / 系统通知                        │
│  ├── IPC 处理器（见 §5）                                                    │
│  └── 拖拽：由渲染进程 pointermove 事件驱动（见 §4.2）                    │
│ lib/balance.js ── fetch(api.deepseek.com/user/balance)  25s TTL 缓存       │
│                  fetch(platform .../usage/by_api_key/…)  峰谷定价换算       │
│ lib/ledger.js  ── 余额差值记账 usage.json（跨天归档 30 天）                │
│ lib/config.js  ── config.json 消毒/原子写/0600/环境变量覆盖               │
└──────────────▲──────────────────────────────────▲──────────────────────────┘
      IPC invoke/send  │（contextIsolation + sandbox + CSP）│
┌──────────────────────┴───────────┐   ┌───────────────────┴─────────────────┐
│ preload.js → window.whaleAPI     │   │ preload.js → window.whaleAPI       │
│ 渲染进程 renderer/pet.*（桌宠）   │   │ 渲染进程 renderer/menu.*（设置）    │
│   SVG 气泡 / 鲸鱼 PNG / 音效       │   │  表单控件 → setConfig → 广播生效   │
│   pointer 拖拽 + 命中忽略            │   │  Esc / blur 自动收起               │
└──────────────────────────────────┘   └────────────────────────────────────┘
```

- **原版映射**：DSH 插件 = 宿主侧 `apply(ctx)`（路由 + fetch + 记账）＋ `WIDGET_JS`（页面 UI）。本版把宿主侧拆到 `lib/*`（纯 Node，可单测），把 `WIDGET_JS` 改写成 `renderer/pet.js`（`/dsh-whale/*` 路由 → `window.whaleAPI` 桥）。
- **两个窗口而非一个**：鲸鱼窗正方形（基准 320px），设置窗独立 376×640 透明弹窗。避免「菜单必须溢出鲸鱼窗」导致的裁剪问题；也避免「大矩形窗口挡住桌面」。
- **安全**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、两侧页面 CSP 仅允许 `file:`；API Key 只在主进程内存与 0600 配置文件中，渲染进程拿不到明文（本地 file: 上下文可信，但坚持最小暴露）。

## 4. 关键实现

### 4.1 透明置顶 + 点击命中（重要：一次真实 bug 的修复记录）

```js
petWin = new BrowserWindow({ transparent: true, frame: false, alwaysOnTop: true,
  skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000' })
petWin.setAlwaysOnTop(true, 'screen-saver')
petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
```

- **透明点击穿透（v1.6 起用 window.setShape）**：初版曾尝试 `setIgnoreMouseEvents(forward)` 与主进程光标轮询，Linux/XWayland 下事件转发不可靠、光标为事件缓存，均致真实点击穿透/拖不动的死锁（详见 §4.2 返工记录）。现在改为：渲染进程按**鲸鱼盒 + 气泡（展开时）+ 汉堡按钮**的布局盒（offset*，不含动画 transform）计算窗口内矩形，经 `pet:shape` 让主进程 `petWin.setShape(rects)` 裁剪窗口——**窗口只在鲸鱼/气泡/按钮处存在，其余透明区域的自然穿透到下方桌面/窗口**。换图、开合气泡、缩放后重报（矩形钳制在窗口范围内）。

### 4.2 拖拽（v1.4：主进程双通道引擎 + 自由定位，真实鼠标可拖、无抽搐）

拖拽引擎整体收归**主进程**，渲染进程仅做两件事：收集原始位移 `e.movementX/Y` 逐事件上报、松手后钳制定位+保存位置。

- **主通道（光标权威）**：`drag:start` 后主进程 16ms 轮询 `screen.getCursorScreenPoint()` → `pos = cursor − offset` → clamp → `setPosition`。与参考实现 deepseek-whale-pet 同款；真实鼠标移动会更新其事件缓存，无任何窗口相对坐标参与 → 无反馈回路。
- **备通道（原始位移）**：渲染进程把每个 pointermove 的 `(movementX, movementY, clientX, clientY)` 逐事件直发主进程（单事件失败互不影响）；主进程**逐事件**执行：一致性守卫（`Δclient ≈ movement − Δwindow`，容差 8px，拒绝窗口移动合成的回送事件）→ 以自身 `getBounds()` 为基准累加位移 → clamp → `setPosition`。光标通道一旦真实移动即锁定权威（`cursorLock`），增量通道让位。
- **返工记录（全部实测复现）**：client/screen 与窗口位置耦合——绝对式「起点+client 位移」→ 2 帧追逐振荡；`screenX` 本环境为 winPos+client 合成值 → 误差指数放大；渲染进程做位移累加 + rAF 合并发送 → 被守卫拒绝的真实噪声事件会顺带吞掉未发送的位移；均废弃。逐事件直发 + 主进程权威解决。
- **验证**：冒烟测试向渲染进程派发物理一致的合成 PointerEvent（movementX 探针 [-12,-20] 确认构造事件携带），三条断言连续多轮通过：落点 = 起点 + Σmovement（exact）、轨迹单调无回摆（noTwitch）、连续拖拽贴到 workArea 上边缘（reached）。真实噪声事件（真实鼠标微动）与合成事件混杂时依旧稳定（守卫逐事件独立）。
- 松手回渲染进程 `finishDrag`：**自由定位**（v1.4 起取消四分之一贴边吸附与左吸附镜像翻转——实测吸附会在放大窗口后把鲸鱼拽回边缘，导致「修改大小后难以移动」；现在仅 clamp 在桌面 workArea 内，可自由贴到任意边缘），随后 `setConfig({posX, posY})` 记忆位置。
- **缩放固定角**：缩放改变窗口尺寸时固定鲸鱼右下角（`fixX = posX + oldW`、`fixY = posY + oldH`），随后钳制回 workArea。
- **验证**：smoke 向渲染进程派发携带显式 movementX 的合成 PointerEvent（走真实处理器代码），断言落点 = 起点 + movement 总和（exact）、轨迹单调（noTwitch）、连续拖拽贴到 workArea 上边缘（reached）。

### 4.3 余额拉取（与原版一致）

- `GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <key>`，20s 超时。
- `balance_infos` 选取优先级：**CNY 且 >0 → 任意非零 → CNY → 第一项**。
- 重试：网络错误/超时/5xx 重试 1 次（间隔 500ms）；4xx 不重试。
- 缓存：**25s TTL** + in-flight 去重；瞬时失败（非 4xx）时返回缓存中的最近余额并标记 `stale`，不报错。
- 每次成功观测都会先写入记账账本（两种模式共用），令牌模式失败自动回落记账模式。

### 4.4 今日已用

**记账模式**（默认）：`todayUsage += max(0, lastBalance - currentBalance)`；余额上升（充值）不扣减；跨天 `todayUsage` 归档到 `history[date]`（保留 30 天）并清零。文件 `~/.config/whale-pet/usage.json`。

**令牌模式**：`GET platform.deepseek.com/api/v0/usage/by_api_key/amount?start=…&end=…&tz=…`，对返回的 token 分桶按 **峰谷定价** 换算：

| 单价（元/百万 token） | 空闲 0–9/12–14/18–24 点 | 高峰 9–12/14–18 点（北京时间） |
|---|---|---|
| 缓存命中输入 | 0.05 | 0.10 |
| 缓存未命中输入 | 1.50 | 3.00 |
| 输出（含推理） | 4.50 | 9.00 |

`deepseek-v4-pro` 为 3 倍价（0.15/0.30、4.50/9.00、13.50/27.00，官方 2026-08-17 生效）；其余模型（chat/reasoner/flash/vision-exp/未知）按基础价。定价表与峰谷时段在 `lib/balance.js` 顶部，调价时直接改。

### 4.5 视觉与几何（与原版精确一致）

| 项 | 值 |
|---|---|
| 鲸鱼本体 | `assets/DSniang1.png`（610×610 透明 cut-out），右下角 59.45% |
| 基础尺寸 | 320px × 缩放 0.6–2.5（默认 1.0），`--wp-u = base/1026` 全联动 |
| 气泡 SVG | viewBox 0 0 1026 700；形如原版（椭圆 (454,247) rx373 ry232；尾巴连接 (301,465)-(413,484)；描边 #203170 宽 18） |
| 文字 | A=66u/600、B=128u/800 金额、P=104u/800（峰谷）、C=56u/#9fb0d9（提示） |
| 金额格式 | CNY → `¥ x.xx`；其他 → `x.xx 币种` |
| 按压 Q 弹 | `scaleY(0.88) scaleX(1.05)`，0.22s cubic-bezier(.34,1.56,.64,1)，原点 50% 100% |
| 数字滚动 | 700ms ease-out 三次方（requestAnimationFrame） |
| 变化提示 | 变化 900ms 内先弹气泡再滚数字（300ms 延迟起滚） |
| 气泡展开 | bshape/b1/b2 依次延迟 0/0.13/0.26s，收起 5s 自动 |
| 随机台词 | 加权池：峰谷组 45、好模型 7、卖萌吐槽 7、gif 10、梗 3、哦鲸鲸 1 |
| 呼吸动画 | 2s 正弦 1.00→1.02→1.00（CSS keyframes，拖拽时暂停） |
| 闲置半透明 | 指针离开 3s → opacity 0.6（0.4s 过渡） |
| 情绪表情 | 💤 加载 / 😭 错误 / 🥺 低余额 / 常态隐藏 |

### 4.6 音效

`<audio>` 加载 `assets/Ya1/Ya2.mp3`（duck）或 `D1/D2.mp3`（fx1）；按压播放 press，松手在 press 结尾前 100ms 或结束后播放 release（与原版时序一致）；`autoplayPolicy: no-user-gesture-required` 免手势门槛；音量 0 即静音。

### 4.7 主图 / 预警图（可上传，彼此独立）

- 配置：`mainImgPath`（默认 `assets/DSniang1.png`）、`alertImgPath`（默认 `assets/DSniang02.png`）、`alertImage`（默认 false）。
- **上传**：设置窗「选择图片」→ 主进程 `dialog.showOpenDialog`（png/jpg/jpeg/gif/webp）→ **复制**到 `~/.config/whale-pet/images/main.*` 或 `alert.*` → 写回绝对路径到配置（与源文件解耦，源文件移动/删除不影响）；「恢复默认」写回内置相对路径。
- **触发**：`alertImage === true` 且余额正常（status ok）且 `0 <= 余额 < lowBalanceThreshold` 时使用预警图，否则使用主图 —— 两张图互不干扰、各自独立。
- **换图**：`img.src` 切换并重建 alpha 命中探针（`setupHitTest(src)`，探针加载期间放宽为全命中保证可点击）；预警时叠加红色 `!` 徽标与 🥺 情绪表情。
- 判定在每次 `render()` 中执行（含余额变化、模式切换、配置广播），与低余额通知共用阈值语义。

### 4.8 自定义气泡文案 + 颜色 + 暗色主题 + 原生设置窗口

- **气泡文案**：`bubbleTextOk` / `bubbleTextLow`（限 20 字符，config 消毒 trim + slice(0,20)，空白回退默认）。气泡默认内容第一行按 `isLowBalance()` 二选一；随机台词段不受影响。
- **文案颜色**：`textColorOk` / `textColorLow`（`#rrggbb` 或空=继承默认 #536ba9），随文案状态切换。菜单提供色板 + 「默认」按钮。
- **峰谷自定义词**：`peakTextOff` / `peakTextOn`（各限 12 字符）；非空时覆盖内置/峰谷模式文案。
- **暗色主题**：设置窗 `theme`（system/light/dark）。菜单页用 CSS 变量双主题，`menu.js` 根据配置 + `matchMedia('(prefers-color-scheme: dark)')` 设置 `html[data-theme]` 并监听系统变化；**主进程同步 `nativeTheme.themeSource`**，系统标题栏/原生控件/下拉弹层随之换肤。选择栏修复：`appearance:none` + 实色背景（`--wm-select-bg`）+ 自绘箭头 + `option` 显式前景/背景色（Chromium 原生 select 会被系统白底覆盖 → 暗色下白字白底）。
- **原生设置窗口**：frame:true（系统标题栏）、非透明、非置顶、可关闭；Tab 标签页（账户/数据/外观/文案/音效/图片台词）在页面内切换，内容分区；不再 `blur` 自动收起。**按需重建**：用户直接叉掉窗口后（closed → null），`openMenu()` 会以鲸鱼旁的坐标重新创建并打开（坐标随构造函数传入，避免部分 WM 首次 map 时默认居中）；托盘/右键/鲸鱼按钮统一走 `openMenu()`。

### 4.9 自定义音效 + 随机台词/动图池 + 去 Emoji

- **自定义音效**：`pressSound` / `releaseSound`（路径或空）；设置窗「上传」→ 主进程文件对话框（mp3/wav/ogg/m4a/flac）→ 复制到 `~/.config/whale-pet/sounds/{press,release}.*` → 写回绝对路径；非空时覆盖当前音效集的按压/松手音源。
- **lines.json（含全部默认值）**：`~/.config/whale-pet/lines.json` —— **随机台词/动图池完全移出渲染进程代码**，首次访问由主进程写入默认池（与原版权重一致的 6 组），用户可自由编辑后「重载」（`custom:get`/`custom:reload` 广播 `custom:changed`）。格式：`{ gif, groups: [ {weight, type: balance|gif} | {weight, lines:[{text≤40, style A|B|P|C, wrap?, color?}×≤3]} ... ] }`；空池回退默认。
- **去 Emoji**：主界面（鲸鱼窗口）的情绪表情覆盖层（💤/😭/🥺）已整体移除，预警状态仅保留文字状态（预警图切换 + `!` 徽标）；菜单标题/眼睛按钮/通知标题的 emoji 一并移除。

## 5. IPC 协议（preload → 主进程）

| 通道 | 类型 | 说明 |
|---|---|---|
| `config:get` / `config:set` | invoke | 读/写配置；set 后广播 `config:changed`；Key/令牌/用量模式变化时使余额缓存失效；autostart 变化时写 XDG desktop 文件 |
| `balance:get` | invoke | 余额快照（含 todayUsage/isPeak/usageMode/stale/error） |
| `window:get-workarea` | invoke | 鲸鱼所在显示器的 workArea |
| `window:resize` / `window:set-pos` | send | 改窗口尺寸/位置（resize 后重申置顶，防部分 WM 掉层） |
| `image:pick` / `image:reset` | invoke | 上传主图/预警图（复制到配置目录）/ 恢复内置默认 |
| `sound:pick` / `sound:reset` | invoke | 上传自定义按压/松手音效 / 恢复默认 |
| `custom:get` / `custom:reload` | invoke | 读 lines.json（首次自动生成默认池）/ 重读并广播 `custom:changed` |
| `menu:open` / `menu:close` | send | 打开（鲸鱼旁、屏幕内钳制）/收起设置窗 |
| `config:changed` / `whale:refresh` | 事件 | 广播回渲染进程 |

> 注：初版包含 `pet:hover`（点击穿透命中）通道，因 Linux/XWayland 下不可靠已移除，见 §4.1。

## 6. 安全

- 渲染进程禁 Node（`sandbox`+`contextIsolation`），仅有白名单 IPC 方法。
- 页面 CSP：`default-src file:`（媒体/图片/脚本仅本包资源）。
- 配置目录 0700、文件 0600，写入走 tmp+rename 原子替换，不落键值于日志。
- 环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_PLATFORM_TOKEN` 优先级高于配置文件；配置中标记来源以便 UI 提示。
- 单实例锁防多开；`--smoke-test` 模式兜底 20s 退出。

## 7. 验证

- **单元测试**（`npm test`，纯 Node 无网络）：峰谷边界、定价表、`pickBalanceInfo` 优先级、token→金额换算、`fetchBalance` 重试/4xx 不重试/超时瞬态、记账累计/充值不扣减/跨天归档、配置消毒/0600/环境变量覆盖/预警换图/主图路径/主题/20 字符文案 —— 全部通过。
- **冒烟测试**（`npm run smoke`，真实启动）：截图验证渲染（鲸鱼右下角覆盖、点击后白色气泡出现）、模拟点击（气泡弹出）、**真实输入管线拖拽**（事件驱动跟手 moved=true、连续拖拽到达 workArea 上边缘 reached=true）、真实调用余额接口（无 Key 返回 NO_KEY、坏 Key 返回 HTTP 401）—— 全部通过。另以「上传图片 + 深色主题 + 自定义文案」配置跑通：主图来自用户上传路径（像素级确认渲染）、菜单深色主题（平均色 RGB 43,46,61）。
- **真实鼠标点击验证**（xdotool，详见 §4.1）：修复前（OS 级穿透方案）点击后气泡不出现（BUBBLE=false）；修复后（整窗接收事件方案）真实点击立即弹出气泡（连续 14 次探针采样 BUBBLE=true）。
- 手动清单见 README「验证」章节。

## 8. 扩展建议

1. 多主题/多皮肤（换 `assets/DSniang1.png` + 调色变量即可）。
2. 多平台余额聚合（OpenAI / Claude / 硅基流动）。
3. 用量热力图（`usage.json` history 已具备 30 天数据）。
4. D-Bus 集成（锁屏隐藏、会话结束后隐藏）。
5. 左右翻转时的按压动画坐标调整（当前沿用原版中心原点）。
