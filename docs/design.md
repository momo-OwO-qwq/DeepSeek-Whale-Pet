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
| 桌宠交互 | 拖拽吸附、镜像翻转、按压 Q 弹、音效、随机台词、汉堡菜单 |
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
│   pointer 拖拽 + 吸附 + 命中忽略   │   │  Esc / blur 自动收起               │
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

- **首版实现**尝试了 OS 级点击穿透：渲染进程做画布 alpha 命中测试（610×610 与素材对齐，左吸附镜像坐标），命中后经 IPC 让主进程 `setIgnoreMouseEvents(false)`，未命中 `setIgnoreMouseEvents(true, {forward:true})`。
- **实测失败**（用户报告「点击小鲸鱼没有反应」+ xdotool 真实点击复现）：在该 Linux/XWayland + Electron 34 环境下，`forward` 事件转发**不会**触发（窗口进入 ignore 后永远收不到 mousemove，无法自我唤醒）；且 **`screen.getCursorScreenPoint()` 是事件缓存的**——光标在受忽略/非当前窗口上时返回过期坐标（xdotool 移动指针后 `xdotool getmouselocation` 已变，而 App 读到的坐标不变），因此「主进程轮询光标」的兜底方案同样失效。两条通道全部被验证为不可靠（用独立探针程序逐项证明）。
- **最终方案（与参考实现 deepseek-whale-pet 一致）**：**完全不做 OS 级穿透**——窗口始终接收鼠标事件；渲染进程用 `isWhaleHit` 画布 alpha 判定，鲸鱼本体（及气泡/菜单按钮）之外的点按直接忽略。代价是窗口矩形内的透明区域会吃掉点击，换来的是**真实鼠标点击 100% 可靠**，并用 xdotool 真实点击自动化验证通过（修复前 BUBBLE=false，修复后 BUBBLE=true 连续 14 次探针采样）。
- `focusable: false` 也被移除：与参考实现一致的最小窗口属性集，避免个别 WM 下的输入怪癖。

### 4.2 拖拽 + 吸附（v1.1 重写：不再依赖系统光标 API）

- 渲染进程 `pointerdown` 记录**拖动起点窗口位置**（`state.posX/posY`，渲染进程始终维护）与按压位置 `(clientX, clientY)`；`setPointerCapture` 保证指针移出窗口仍持续收到 `pointermove`/`pointerup`。
- 每次 `pointermove`：`目标 = 起点窗口位置 + (当前 client - 起点 client)` —— **完全事件驱动，不调用 `screen.getCursorScreenPoint()`**；`requestAnimationFrame` 节流后经 `setWindowPos` 发送给主进程 1:1 跟手（拖过四个边由 clamp 收住）。
- v1.0 曾用主进程 16ms 轮询光标（`getCursorScreenPoint`）驱动拖拽，实测该 API 在 Linux/XWayland 下是**事件缓存**：xdotool 移动指针后 App 读到的是过期坐标 → 真实拖动几乎不动（用户报告「不能拖动到桌面四边」）。重写后以真实指针事件为准，任意距离可达任何桌面边，冒烟测试用 `sendInputEvent` 全链路验证（常规拖动 moved=true、连续向上拖到达 workArea 上边缘 reached=true）。
- 松手回渲染进程完成**四分之一吸附**（中心 x < 1/4 → 左、> 3/4 → 右；y 同理），吸附后 `setConfig({posX,posY,posH,posV})` 记忆位置。
- **左吸附镜像**：`state.h==='left'` 时根节点 `scaleX(-1)`，气泡文字反向 `scaleX(-1)` 保持可读。
- **缩放固定角**：缩放改变窗口尺寸时，非翻转锚鲸鱼右下角、翻转锚左下角不动（`fixX/fixY`），随后钳制回 workArea。

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

### 4.8 自定义气泡文案 + 暗色主题

- **气泡文案**：`bubbleTextOk` / `bubbleTextLow`（默认 `DeepSeek 余额` / `余额预警`，均限 20 字符，config 消毒时 trim + slice(0,20)，空白回退默认）。气泡默认内容的第一行文字按 `isLowBalance()` 二选一；随机台词段不受影响。
- **暗色主题**：设置窗 `theme`（system/light/dark）。菜单页用 CSS 变量实现双主题，`menu.js` 根据配置 + `matchMedia('(prefers-color-scheme: dark)')` 设置 `html[data-theme]` 并监听系统变化；`system` 模式下系统切换实时跟随。鲸鱼本体（浅色 UI）不受主题影响。

## 5. IPC 协议（preload → 主进程）

| 通道 | 类型 | 说明 |
|---|---|---|
| `config:get` / `config:set` | invoke | 读/写配置；set 后广播 `config:changed`；Key/令牌/用量模式变化时使余额缓存失效；autostart 变化时写 XDG desktop 文件 |
| `balance:get` | invoke | 余额快照（含 todayUsage/isPeak/usageMode/stale/error） |
| `window:get-workarea` | invoke | 鲸鱼所在显示器的 workArea |
| `window:resize` / `window:set-pos` | send | 改窗口尺寸/位置（resize 后重申置顶，防部分 WM 掉层） |
| `image:pick` / `image:reset` | invoke | 上传主图/预警图（复制到配置目录）/ 恢复内置默认 |
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
