# Porting Spec — 自定义 API 多厂商模型注册表 + 记账内核

来源（只读分析，未写入任何工程代码）：
> 上游仓库 MeteorNOX/DeepSeek-Balance-Whale-Widget @ v0.3.5
- 上游 `lib/index.js`（3279 行，ESM DSH 宿主插件）
- 上游 `lib/accounting.mjs`（187 行）
- 上游 `assets/whale-widget.js`（前端本体，仅用于核对展示语义）

> 说明：本文档是**下一阶段**（多厂商 API + 记账内核）的移植规格，本轮未实施。
> 本文档保留供后续开发者按图施工；本轮已交付范围见 `docs/design-v035.md`。

`L###` = `lib/index.js` 行号；`acct:` = `lib/accounting.mjs`；`wid:` = `assets/whale-widget.js`。

---

## 0. Files, paths, constants (L71–L97, L368–L382)

```js
DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')      // L22
```

| Constant | Value (L) | Meaning |
|---|---|---|
| `API_FILE_CANDIDATES` | `[$DSH_HOME/.dshw-api.json`, `$DSH_HOME/profiles/web/.dshw-api.json`] | L73–76 registry write candidates, first writable wins |
| `API_BUILTIN_ID` | `'deepseek'` | L77 built-in id, never stored in the registry file |
| `USAGE_FILE_CANDIDATES` | `[$DSH_HOME/.dshw-usage.json`, `.../profiles/web/.dshw-usage.json`] | L374–377 ledger |
| `TURN_FILE_CANDIDATES` | `[$DSH_HOME/.dshw-turn.json`, ...] | L379–382 seq file |
| `BALANCE_URL` | `'https://api.deepseek.com/user/balance'` | L431 |
| `BALANCE_TTL_MS` | `25000` | L432 balance cache TTL |
| `ACCOUNTING_VERSION` | `1` | acct:L3 |
| `SCALE` (fixed point) | `100000000` (1e8) | acct:L4 |
| archive file | `.dshw-usage-archive.json` | L831/834 |
| codex cache | `$DSH_HOME/.dshw-codex.json` | L1054/1064/1070 |

JSON headers for every route (L501–505): `Content-Type: application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`.

Plugin shell (L529–532): `name: 'whale-balance-widget'`, `inject: ['webServer','credentials','connection']`.
Every `/dsh-whale/*` route is wrapped by `registerRoute()` (L557–566) which first calls `rejected(req,res)` (L537–555) → `ctx.connection.requestRejection(req)`; fail-open with a one-shot `console.warn` if the service is missing.

`dns.setDefaultResultOrder('ipv4first')` at module load (L14) — BigModel et al. have AAAA records that break undici.

---

## 1. Vendor template registry (`API_TEMPLATES`) — 34 templates

Declared `const API_TEMPLATES = {` at **L97**, closes at **L366**. **34 entries** (verified by parsing keys).

### 1.1 Template field dictionary

| Field | Type | Meaning |
|---|---|---|
| *(object key)* | string | template id, i.e. the model's `provider` value. Also the dropdown id. |
| `name` | string | display label (Chinese/English mixed) |
| `currency` | `'CNY'\|'USD'` | default settlement/display currency inherited by models |
| `keyRef` | string | DSH credential name, e.g. `DEEPSEEK_API_KEY`. `''` = no credential (codex/ollama) |
| `builtin` | bool? | only `true` on `deepseek`; unlocks `canAdjustBuiltinBalance()` |
| `kind` | `'balance'\|'quota'\|'codex'\|undefined` | **absent ⇒ `'balance'`** (see L1977 `String(T[k].kind \|\| 'balance')`). `'quota'` = subscription windows not money; `'codex'` = local JSONL stats, no network/key |
| `noBalanceApi` | bool? | vendor has no key-queryable balance endpoint; UI shows `—` and estimates from session events |
| `apiNote` | string? | user-facing explanation shown in the panel for `noBalanceApi` vendors |
| `needsBaseUrl` | bool? | template requires a Base URL (`openai_compat`, `ollama`) |
| `matchIds` | string[]? | substrings used to attribute a session-model name to this model (also feeds custom price table). Capped to 12 in the template payload (L1980) |
| `probeUrl` | string? | connectivity-test ("测试连通性") endpoint. Supports `{base}` and `{key}`. Falls back to balance URL, then `base + '/v1/models'` (L1444). Absent ⇒ no probe offered |
| `balance` | object? | how to read money balance (see 1.2) |

### 1.2 `balance` descriptor

| Field | Meaning |
|---|---|
| `url` | HTTP(S) endpoint. Supports `{base}` (model `baseUrl`, trailing slashes stripped) and `{key}`. `''` = no balance API |
| `auth` | request header template. Default when `null/undefined` is `'Bearer {key}'` (L1397). `'{key}'` for Zhipu (no Bearer). `''` ⇒ no `Authorization` header (Gemini) |
| `json.remaining` | JSON field path → remaining balance |
| `json.total` | path → total/limit (if `remaining` missing, `remaining = total - used`, L1584) |
| `json.used` | path → already-used amount |
| `json.scale` | numeric multiplier applied to each resolved value (`apiNum`, L1341) |
| `balance.usage` | *nested second request*: `{ url, auth?, json:{ used, scale } }`. Only `balance.usage.url` matters as the trigger (L1811). Its `used` is **added** to the first response's `used` (L1582). Used by `openai_compat`: subscription gives `hard_limit_usd` (dollars), usage gives `total_usage` in **cents** → `scale: 0.01` |

Resolution order in `fetchModelBalance` (L1551–1590):
`remaining = apiNum(pick(data, j.remaining), j.scale)`; same for `total`; `used` accumulates from `j.used` **and** from `b.usage.json.used`. Final: `if (remaining===null && total!==null) remaining = total - used`; if still null → `{ok:false, code:'SHAPE', error:'接口返回里没找到配置的字段（检查 JSON 路径）'}`. Returns `{ok, remaining, total, used, currency}` with `currency = model.currency || tpl.currency || 'CNY'`.

### 1.3 `quota` descriptor (`kind:'quota'`)

| Field | Meaning |
|---|---|
| `quota.url` | endpoint, supports `{base}` |
| `quota.auth` | same auth-template semantics |
| `quota.json.percent` | path → **used %** directly |
| `quota.json.remainPct` | path → **remaining %**; `usedPct = max(0, 100 - p)` |
| `quota.json.weeklyRemainPct` | path → weekly remaining %; `weeklyUsedPct = max(0, 100 - p)` |
| `quota.json.remain` + `quota.json.total` | both required together: `remainPct = clamp(r0/t0*100, 0, 100)`, `usedPct = max(0,100-remainPct)` |
| `quota.json.resetAt` | path → absolute reset time (ms, s, or date string) |
| `quota.json.resetAtMs` | path → reset epoch **ms** (overrides `resetAt`) |
| `quota.json.level` | path → plan tier string |
| `quota.json.windows` | array of windows, see §3 |

### 1.4 FULL TEMPLATE TABLE (34)

`kind` shown only when non-`'balance'`. `—` = field absent.

| # | id (L) | name | currency | keyRef | kind | matchIds | probeUrl / notes | balance url → json paths |
|---|---|---|---|---|---|---|---|---|
| 1 | `deepseek` (98) | DeepSeek | CNY | `DEEPSEEK_API_KEY` | — | `['deepseek']` (synthesized, L1319) | `builtin:true`. Balance via legacy `fetchBalance()` path | `https://api.deepseek.com/user/balance` → `remaining: balance_infos[0].total_balance` |
| 2 | `openrouter` (102) | OpenRouter | USD | `OPENROUTER_API_KEY` | — | — | — | `https://openrouter.ai/api/v1/credits` → `total: data.total_credits`, `used: data.total_usage` |
| 3 | `siliconflow_cn` (106) | 硅基流动（CN） | CNY | `SILICONFLOW_API_KEY` | — | `['siliconflow','Qwen','deepseek-ai']` | `https://api.siliconflow.cn/v1/models`; `noBalanceApi:true`, apiNote: builtin offline 2026-08-14 | `url:''`, `remaining:''` |
| 4 | `siliconflow_en` (119) | 硅基流动（EN） | USD | `SILICONFLOW_API_KEY` | — | `['siliconflow','Qwen','deepseek-ai']` | `https://api.siliconflow.com/v1/models`; `noBalanceApi:true` | `url:''` |
| 5 | `moonshot` (128) | Kimi / Moonshot（CN） | CNY | `MOONSHOT_API_KEY` | — | `['moonshot','kimi']` | `https://api.moonshot.cn/v1/models` | `.../v1/users/me/balance` → `remaining: data.available_balance` |
| 6 | `moonshot_intl` (134) | Kimi / Moonshot（国际） | USD | `MOONSHOT_INTL_API_KEY` | — | — | `https://api.moonshot.ai/v1/models` | `https://api.moonshot.ai/v1/users/me/balance` → `remaining: data.available_balance` |
| 7 | `stepfun` (140) | 阶跃星辰 StepFun | CNY | `STEPFUN_API_KEY` | — | `['stepfun','step-']` | — | `https://api.stepfun.com/v1/accounts` → `remaining: balance` |
| 8 | `novita` (144) | Novita AI | USD | `NOVITA_API_KEY` | — | `['novita']` | — | `https://api.novita.ai/v3/user/balance` → `remaining: availableBalance`, **`scale: 0.0001`** |
| 9 | `volcengine_ark` (148) | 火山方舟 Ark | CNY | `ARK_API_KEY` | — | `['doubao','ep-']` | `https://ark.cn-beijing.volces.com/api/v3/models`; `noBalanceApi:true` (balance needs Volcengine AK/SK) | `url:''` |
| 10 | `zhipu_glm_coding` (161) | 智谱 GLM Coding Plan（订阅） | CNY | `ZHIPU_API_KEY` | **quota** | — | `https://open.bigmodel.cn/api/monitor/usage/quota/limit`; `auth:'{key}'` (no Bearer) | `json:{percent:'data.limits[0].TOKENS_LIMIT.percentage', resetAt:'data.limits[0].nextResetTime', level:'data.level'}` |
| 11 | `kimi_coding` (170) | Kimi Coding（订阅） | CNY | `KIMI_CODING_KEY` | **quota** | — | `https://api.kimi.com/coding/v1/usages`, `Bearer {key}` | `json:{remain:'usage.remaining', total:'usage.limit', resetAt:'usage.resetTime'}` |
| 12 | `minimax_coding` (179) | MiniMax Coding（订阅） | CNY | `MINIMAX_API_KEY` | **quota** | — | `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` | `json:{remainPct:'model_remains[0].current_interval_remaining_percent', weeklyRemainPct:'model_remains[0].current_weekly_remaining_percent', resetAtMs:'model_remains[0].end_time'}` |
| 13 | `opencode_go` (195) | OpenCode Go（订阅） | USD | `OPENCODE_GO_API_KEY` | **quota** | — | `https://opencode.ai/zen/go/v1/usage`, `Bearer {key}` | `json.windows` = 3 windows (see §3) |
| 14 | `openai_compat` (210) | OpenAI 兼容中转站 | USD | `CUSTOM_API_KEY` | — | — | `needsBaseUrl:true` | `{base}/v1/dashboard/billing/subscription` → `total: hard_limit_usd`; **`usage`**: `{base}/v1/dashboard/billing/usage` → `used: total_usage`, `scale: 0.01` (cents→USD) |
| 15 | `custom` (218) | 自定义 HTTP | CNY | `CUSTOM_API_KEY` | — | — | user fills everything | `url:''`, `remaining:''` |
| 16 | `codex` (225) | Codex（本地会话） | CNY | `''` | **codex** | — | no network, no credential; reads `~/.codex` | `url:''`, `auth:''` |
| 17 | `openai` (233) | OpenAI | USD | `OPENAI_API_KEY` | — | `['gpt','o1-','o3-','o4-','chatgpt']` | `https://api.openai.com/v1/models`; `noBalanceApi:true` | `url:''` |
| 18 | `anthropic` (240) | Anthropic Claude | USD | `ANTHROPIC_API_KEY` | — | `['claude']` | **no probeUrl** (needs `x-api-key` + `anthropic-version`) | `url:''` |
| 19 | `gemini` (246) | Google Gemini | USD | `GEMINI_API_KEY` | — | `['gemini']` | `https://generativelanguage.googleapis.com/v1beta/models?key={key}`; `balance.auth:''` | `url:''` |
| 20 | `xai` (253) | xAI Grok | USD | `XAI_API_KEY` | — | `['grok']` | `https://api.x.ai/v1/models` | `url:''` |
| 21 | `groq` (260) | Groq | USD | `GROQ_API_KEY` | — | `['llama','mixtral','qwen','deepseek','gemma','whisper']` | `https://api.groq.com/openai/v1/models` | `url:''` |
| 22 | `mistral` (267) | Mistral AI | USD | `MISTRAL_API_KEY` | — | `['mistral','codestral','magistral','pixtral','ministral']` | `https://api.mistral.ai/v1/models` | `url:''` |
| 23 | `together` (274) | Together AI | USD | `TOGETHER_API_KEY` | — | `['meta-llama','Qwen','deepseek','mistralai','nvidia']` | `https://api.together.xyz/v1/models` | `url:''` |
| 24 | `fireworks` (281) | Fireworks AI | USD | `FIREWORKS_API_KEY` | — | `['accounts/fireworks','llama-v3','qwen']` | `https://api.fireworks.ai/inference/v1/models` | `url:''` |
| 25 | `deepinfra` (288) | DeepInfra | USD | `DEEPINFRA_API_KEY` | — | `['meta-llama','Qwen','deepseek']` | `https://api.deepinfra.com/v1/openai/models` | `url:''` |
| 26 | `cerebras` (295) | Cerebras | USD | `CEREBRAS_API_KEY` | — | `['llama','qwen']` | `https://api.cerebras.ai/v1/models` | `url:''` |
| 27 | `dashscope` (302) | 阿里云百炼（通义千问） | CNY | `DASHSCOPE_API_KEY` | — | `['qwen','qwq','qvq']` | `https://dashscope.aliyuncs.com/compatible-mode/v1/models` | `url:''` |
| 28 | `qianfan` (309) | 百度千帆（文心） | CNY | `QIANFAN_API_KEY` | — | `['ernie']` | `https://qianfan.baidubce.com/v2/models` | `url:''` |
| 29 | `hunyuan` (316) | 腾讯混元 | CNY | `HUNYUAN_API_KEY` | — | `['hunyuan']` | `https://api.hunyuan.cloud.tencent.com/v1/models` | `url:''` |
| 30 | `spark` (323) | 讯飞星火 | CNY | `SPARK_API_KEY` | — | `['spark','generalv','4.0ultra']` | `https://spark-api-open.xf-yun.com/v1/models` | `url:''` |
| 31 | `modelscope` (330) | 魔搭 ModelScope | CNY | `MODELSCOPE_API_KEY` | — | `['Qwen','deepseek','MiniMax','glm']` | `https://api-inference.modelscope.cn/v1/models` | `url:''` |
| 32 | `ollama` (337) | 本地模型（Ollama / LM Studio） | CNY | `''` | — | `['llama','qwen','gemma','deepseek','mistral','phi']` | `{base}/v1/models`; `needsBaseUrl:true`, `noBalanceApi:true`, `balance.auth:''` | `url:''` |
| 33 | `zhipu_glm_coding_intl` (344) | 智谱 GLM Coding Plan（国际 z.ai） | USD | `ZHIPU_INTL_API_KEY` | **quota** | — | `https://api.z.ai/api/monitor/usage/quota/limit`, `auth:'{key}'` | same json paths as #10 |
| 34 | `minimax_coding_intl` (353) | MiniMax Coding（国际） | USD | `MINIMAX_INTL_API_KEY` | **quota** | — | `https://api.minimax.io/v1/api/openplatform/coding_plan/remains` | same json paths as #12 |

All 19 `noBalanceApi` vendors (#3,4,9,17–32) share the literal `balance: { url:'', auth:'Bearer {key}', json:{ remaining:'' } }` (or `auth:''` for gemini/ollama) and the message pattern in `apiNote`: `'… → 余额「—」，今日已用按会话事件估算'`.

### 1.5 Template sorting & payload (L90–96, L1971–1984)

`TPL_PINYIN_INITIAL = { 阿:'a', 百:'bai', 本:'ben', 硅:'gui', 火:'huo', 阶:'jie', 魔:'mo', 腾:'teng', 讯:'xun', 智:'zhi', 自:'zi' }` (L90).
`tplSortKey(name)` (L91–96): first char → pinyin initial if mapped, else `name.toLowerCase()`. Reason: ICU `localeCompare` pushes CJK after Latin, so Chinese vendors would clump at the end.

`apiModelsPayload()` (L1863–1987) emits per template:
`{ id, name, currency, keyRef, builtin, needsBaseUrl, hasBalance (!!balance.url.trim()), probeUrl, kind, balance (deep-cloned), quota (deep-cloned), matchIds (≤12), noBalanceApi, apiNote, sortKey }` plus top-level `{ ok:true, builtinId:'deepseek', templates, models }`.

### 1.6 Two gaps to fix when porting

1. **`matchIds` is accepted by the UI but never persisted.** `apiSaveModel` (L1778–1861) writes `name, provider, currency, keyRef, baseUrl, balance, price` only — no `model.matchIds = …`. The widget sends `matchIds` (wid:2391). Consequently custom models fall back to `[m.name, m.id]` in `apiAttributeEvent`/`refreshCustomPrices`. Either persist it (recommended) or keep the fallback.
2. **`noBalanceApi` / `kind` are read from the template only** (L1887, L1923, L1925) — a model row cannot override them.

---

## 2. JSON field path resolver

`pickJsonPath(obj, pathStr)` — **L1330–1340**:
```js
const parts = String(pathStr || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0)
let cur = obj
for (const p of parts) { if (cur === null || cur === undefined) return undefined; cur = cur[p] }
return cur
```
Semantics: every `[<digits>]` becomes `.<digits>`; the result is split on `.`; empty segments dropped (so leading/trailing/double dots are harmless); plain property access each step; returns `undefined` on any null/undefined hop or on throw. No `[a]`, no negative index, no `[*]`, no bracket-with-quotes support. Two worked examples: `balance_infos[0].total_balance` → `['balance_infos','0','total_balance']`; `data.limits[0].TOKENS_LIMIT.percentage` → `['data','limits','0','TOKENS_LIMIT','percentage']`.

`apiNum(v, scale)` — **L1341–1346**: `Number(v)`; returns `null` if not finite. `scale` is applied only when `isFinite(Number(scale)) && Number(scale) > 0`, else `1`. Returns `n * s`. Note **scale applies to `remaining`, `total` and `used` alike** (`j.scale` for the main response, `b.usage.json.scale` for the second) — that's how OneAPI's cents are converted.

`mergeNonEmpty(base, over)` — **L1350–1360**: recursive non-empty merge; `undefined`/`null`/`''` in `over` never override `base`; plain objects recurse; arrays are replaced wholesale. Rationale (L1347–1349): empty form fields must not clobber template defaults, otherwise balance lookup breaks with 「未配置余额接口地址」.

`stripEmptyDeep(o)` — **L1362–1373**: recursive empty-strip used on write; drops `undefined`/`null`/`''` and **objects that become empty**; arrays pass through untouched (`return o`). This is what makes `mergeNonEmpty` template defaults survive round-trips. Applied in `apiSaveModel` to `balance.url/auth/json.{remaining,total,used,scale}` and `balance.usage.*`, with lengths capped: url ≤500, auth ≤200, path ≤200, name ≤30, keyRef ≤64, baseUrl ≤300, currency ≤8.

**URL safety** `assertSafeApiUrl(u)` — **L1381–1394**: `new URL` must parse (else `'无效的接口地址'`); protocol must be `http:`/`https:`; rejects hostnames `metadata.google.internal`, `metadata.goog`, `100.100.100.200` (`'禁止访问云元数据地址'`), IPv4 `169.254.x.x` (`'禁止访问 link-local 地址'`), IPv4 `0.x.x.x`, and IPv6 `/^fe[89ab][0-9a-f]:/i`. **Loopback and RFC1918 are deliberately allowed** (ollama/self-hosted gateways).

`apiFetchJson(url, auth, key)` — **L1395–1405**: `auth` defaults to `'Bearer {key}'` when `null`/`undefined`; `headers.Authorization = a.replace('{key}', key)` only when non-empty; `url.replace('{key}', key)`; `assertSafeApiUrl`; `fetch` with `AbortSignal.timeout(15000)`; non-ok → `throw new Error('HTTP ' + res.status)`.

`apiBusinessError(data)` — **L1409–1419**: some APIs return HTTP 200 with a business error. Returns (≤120 chars) `data.msg|message|error` when `data.success === false || data.ok === false`; `data.msg` when `Number(data.code)` is finite and ∉ {0, 200}; `data.error` when a string; `data.error.message` when an object; else `''`.

`apiProbeModel(model)` — **L1420–1457**: builtin → reuse `fetchBalance()`; `kind==='codex'` → `codexSummaryCached()` formatted `'Codex 本地会话：今日 … · 本月 … · 累计 … tokens（N 个会话文件）'` with `f()` formatter (`亿` at ≥1e8, `万` at ≥1e4). Otherwise resolve credential; `b = mergeNonEmpty(tpl.balance, model.balance)`; `base = model.baseUrl.replace(/\/+$/,'')`; `url = String(tpl.probeUrl || b.url || (base ? base+'/v1/models' : '')).replace('{base}', base)`; `{ok:false, error:'没有可测试的接口（请填余额接口或 Base URL）'}` when empty. Detail strings: `'HTTP 200'`, `'可用模型 N 个'` from `data.data[]` or `data.data.models[]`. Errors prefixed `'测试失败: '`.

---

## 3. Subscription/quota window model (`kind:'quota'`)

`fetchModelQuota(model)` — **L1462–1540**. Requires `tpl.quota.url`; else `{ok:false, code:'NO_QUOTA', error:'该厂商没有订阅额度接口'}`. Credential from `model.keyRef || tpl.keyRef`; missing → `{code:'NO_KEY'}`. Auth via `q.auth`.

Parse order:
1. `j.percent` → `usedPct`
2. `j.remainPct` → `remainPct`, and `usedPct = max(0, 100-p)` only if `usedPct === null`
3. `j.weeklyRemainPct` → `weeklyUsedPct = max(0, 100-p)`
4. `j.remain` + `j.total` (both needed, `t0` truthy) → `remainPct = max(0, min(100, r0/t0*100))`, `usedPct = max(0, 100-remainPct)`
5. `j.resetAt` → raw `resetAt`; `j.resetAtMs` overrides with a number
6. `j.level` → `level` string

### 3.1 Multi-window (`quota.json.windows`) — L1506–1532

OpenCode Go (L195–209) declares three windows:
```js
windows: [
  { key:'rolling', label:'5h',  percent:'usage.rolling.percent', resetAt:'usage.rolling.resetsAt' },
  { key:'weekly',  label:'周',  percent:'usage.weekly.percent',  resetAt:'usage.weekly.resetsAt' },
  { key:'monthly', label:'月',  percent:'usage.monthly.percent', resetAt:'usage.monthly.resetsAt' },
]
```
Normalization (L1507–1522): for each window `wp = clamp(pick(data,w.percent), 0, 100)`; `wr = pick(data,w.resetAt)` kept when `!== undefined|null|''`; **skip the window entirely if both are null**; push `{ key: String(w.key||''), label: String(w.label||''), usedPct: wp, resetAt: wr }`. `windows = list` only when non-empty.

Back-fill for single-window compatibility (L1523–1531):
- `if (usedPct === null && w0.usedPct !== null) usedPct = w0.usedPct`
- `if (!resetAt && w0.resetAt !== null) resetAt = w0.resetAt`
- `if (weeklyUsedPct === null)` scan for the first window with `key === 'weekly' || label === '周'` and non-null `usedPct`

Failure: all of `usedPct`, `remainPct`, `resetAt`, `windows` null → `{ok:false, code:'PARSE', error:'额度接口返回无法解析（字段路径不匹配）'}`. Network throw → `{ok:false, code:'HTTP', error:'额度接口请求失败: …'}`.
Success: `{ ok:true, usedPct, remainPct, resetAt, level, weeklyUsedPct, windows }`.

`apiPlanNoPlan(msg)` — **L1543–1549**: lowercases and returns true if it contains any of `'coding plan'`, `'不存在'`, `'未订阅'`, `'not subscribed'`, `'no plan'`, `'no active'`, `'subscription'`. Caller sets `entry.plan.hide = true` (L1955) so a non-subscriber's row is hidden rather than shown as an error.

Wiring in `apiModelsPayload` (L1952–1957): only when `tplM.quota && hasKey`; `entry.planSupport = !!tplM.quota` (L1923).

### 3.2 Display (frontend, `assets/whale-widget.js`)

- Panel % text: `apiPlanPctText(v)` → `'--'` when null, else `Number(v).toFixed(1).replace(/\.0$/,'') + '%'` (wid:10966).
- Reset normalization `apiPlanResetMs(t)` (wid:11047): number `< 1e12` treated as seconds → `*1000`; else ms; string → `Date.parse`.
- Long countdown `apiPlanCountdownText(ms)` (wid:11053): `left = ms - Date.now()`; `<= 0` → `'即将重置'`; `d = floor(h/24)`; `d>0` → `` `${d}天${h%24}小时后重置` ``; else `` `${h}小时${floor((left%3600000)/60000)}分后重置` ``. Short variant `apiPlanCountdownShortText` used in `all` mode.
- Multi-window selection: `BUBBLE_PLAN_WIN_OPTS = [['all','全部（5h / 周 / 月）'], ['rolling','5h'], ['weekly','周'], ['monthly','月']]` (wid:10975). Module field `planWin` (default `'all'`). `apiPlanPctWinText(modelId, win, left)` (wid:11021): `all` joins all windows with `' · '`, each rendered `` `${w.label} ${pct}` `` (label included only if present); a specific `win` matches by `w.key` and returns `'--'` if not found. `left=true` renders `max(0, 100-usedPct)`. Reset text `apiPlanResetWinText` uses the short countdown and the same `·` join. If `windows` is null both return `null` → caller falls back to single-window `p.usedPct`/`p.remainPct`.
- The "显示样式" dropdown is only offered when `apiPlanMultiWin(modelId)` (wid:10999) finds the template with `q.json.windows.length` truthy. Module label becomes `额度·<name>（<label>）` (wid:10996).

---

## 4. `.dshw-api.json` — persisted registry shape

Defaults: `defaultApiRegistry()` → `{ version: 1, models: [], usage: {} }` (**L1293**).
`readApiRegistry()` (L1294–1305): tries each candidate; accepts the first parsed object **with `Array.isArray(parsed.models)`**; coerces missing `usage` to `{}`; else returns defaults. Note it swallows all errors (including JSON parse), so a corrupt file silently resets to empty.
`writeApiRegistry(reg)` (L1306–1312): `JSON.stringify(reg, null, 2)` (pretty, 2-space); first writable candidate wins; returns bool. **Not** atomic (no temp+rename) — unlike the usage ledger.

```jsonc
{
  "version": 1,
  "models": [ /* Model[] */ ],
  "usage": { "<modelId>": /* ModelUsage */ }
}
```

### 4.1 `Model` (written by `apiSaveModel`, L1778–1861)

| Field | Type | Notes |
|---|---|---|
| `id` | string | existing kept, else `'api_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7)` (L1784). `'deepseek'` reserved |
| `createdAt` | number | epoch ms, set on creation only |
| `name` | string | `p.name.trim().slice(0,30)` else `tpl.name` |
| `provider` | string | a template key; unknown → `{ok:false, error:'未知的厂商模板'}` |
| `currency` | string | `String(p.currency || tpl.currency || 'CNY').toUpperCase().slice(0,8)` |
| `keyRef` | string | credential name; ≤64; takes `p.keyRef || tpl.keyRef || ''`, else falls back to `tpl.keyRef` |
| `baseUrl` | string? | only set `if (p.baseUrl !== undefined)`; ≤300; `{base}` substitution source |
| `balance` | object? | deleted entirely when it strips to nothing |
| `balance.url` | string | ≤500 |
| `balance.auth` | string | ≤200 |
| `balance.json.remaining` / `.total` / `.used` | string | ≤200 each |
| `balance.json.scale` | number? | only when finite |
| `balance.usage.{url,auth,json.used,json.scale}` | — | only when `p.balance.usage.url` truthy |
| `price` | object? | see 4.3; deleted when all three of hit/miss/out are `undefined`, or on `p.price === null` |
| `matchIds` | — | **never written (gap)** |

Credential side effect (L1854–1859): when `p.keyValue` is a non-empty string, `await ctx.credentials.set(keyRef, String(p.keyValue))`; `keySaved` returned. Other credential routes (L2653–2668): `set-key` → `svc.set(ref, value)`; `delete-key` → `svc.unset(ref)` if available (REQUIRED for plain keys in the credentials `refs` section — `deleteRecord` only handles structured `records` and silently no-ops on refs), else `svc.deleteRecord(ref)`.

### 4.2 `ModelUsage` — per-model daily + cumulative

Skeleton `apiUsageNewDay(cur, day, dayKey)` (**L1592–1601**):
```js
{ day, dayStart: null, lastBalance: null, delta: 0, eventCost: 0, eventTokens: 0, currency: '',
  tokensTotal: Number(prev.tokensTotal) || 0,
  month: String(dayKey).slice(0,7),
  tokensMonth: prev.month === mk ? (Number(prev.tokensMonth)||0) : 0 }
```
Daily fields reset on rollover; `tokensTotal` always carries; `tokensMonth` carries only within the same calendar month.

`apiRecordBalance(id, remaining)` (**L1603–1619**) — per-model balance-delta accounting (mirrors the DeepSeek ledger):
- reset `cur` when `cur.day !== todayKey()`
- `if (cur.dayStart === null) cur.dayStart = remaining`
- `if (typeof cur.lastBalance === 'number' && remaining < cur.lastBalance) cur.delta = addMoney(cur.delta, cur.lastBalance - remaining)`
- `cur.lastBalance = remaining`; persist; returns `cur` (or `null` on throw)
- **Increases are ignored here** (no credit tracking per model).

`apiTodayUsage(id, modelCurrency)` (**L1623–1632**) → `{amount, source, currency}`:
- no row / stale day → `{amount:0, source:'none', currency: mcur}`
- `lastBalance` is a finite number → `{amount: preciseMoney(cur.delta||0), source:'balance', currency: mcur}` (**vendor currency**)
- else → `{amount: preciseMoney(Number(cur.eventCost)||0), source:'events', currency:'CNY'}` (**CNY**)
Currency tagging is essential: a USD-priced model must not render a CNY amount with `$`, nor compare the two directly.

`apiUsageRaw(id)` (L1633–1638) returns the raw row or `null`.

### 4.3 Custom unit price (`model.price`) — L1822–1849, L462–481, L1750–1777

Shape: `{ hit, miss, out, cur?, rate? }` — prices in **currency per 1,000,000 tokens**, `cur` ∈ `'CNY' | 'USD'`, `rate` = CNY per USD.

Validation (L1831–1844), each returning `{ok:false, error}`:
- any of hit/miss/out outside `[0, 1000000]` → `'单价必须是 0–1000000 之间的数字（单位：币种/百万 token）'`
- `rate !== undefined && !(rate > 0 && rate <= 1000)` → `'汇率必须是 0–1000 之间的正数（元/USD）'`
- `anyPrice && cur === 'USD' && !(rate > 0)` → `'单价币种为美元时必须填写汇率（元/USD）'`
- blanks are `undefined` (not 0) via the `num()` helper (L1823–1827), so "unset" stays distinguishable.

`refreshCustomPrices()` (**L1750–1777**), 10 s throttle via `customPriceAt`:
- skips `id === API_BUILTIN_ID` (DeepSeek keeps its own peak/valley table)
- builds `CUSTOM_PRICES[key] = { hit:[v,v], miss:[v,v], out:[v,v] }` — **identical for both peak and off-peak slots**, i.e. custom prices are peak-invariant (README L84)
- `CUSTOM_PRICE_META[key] = { cur: upper(pr.cur || 'CNY'), rate: finite(pr.rate) ? Number(pr.rate) : 0 }`
- keys = `matchIds` (fallback `[m.name, m.id]`), lowercased+trimmed, **skipped when `k.length < 3`** (L1771) to avoid `pro`/`flash` false hits
- `apiSaveModel` sets `customPriceAt = 0` after any save (L1852) and `apiDeleteModel` does the same (L1708), so a new price applies immediately rather than up to 10 s late.

Lookup `priceFor(model)` (**L470–481**): lowercases the model name; scans `CUSTOM_PRICES` keys **sorted by descending key length** (longest match wins) and returns the first substring hit; then scans `PRICING` keys (skipping `_default`) the same way; finally `PRICING._default`. `customPriceMetaFor(model)` (L462–469) does the identical longest-first scan over `CUSTOM_PRICE_META`.

Built-in `PRICING` (L446–457), CNY per million tokens, `[offPeak, peak]`:
- `BASE_PRICE = { hit:[0.02,0.04], miss:[1,2], out:[4,8] }` → `deepseek-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-flash`, and `_default`
- `PRO_PRICE = { hit:[0.15,0.3], miss:[4.5,9.0], out:[13.5,27.0] }` → `deepseek-v4-pro`
- Peak windows `PEAK_HOURS = [[9,12],[14,18]]` (L441) Beijing time, weekdays only; weekend valley from `WEEKEND_VALLEY_FROM_SEC = floor(Date.UTC(2026,7,22,16,0,0)/1000)` (L485) = Beijing 2026-08-23 00:00. `isPeakTime(timeSec)` (L486–499): shifts by `+8*3600*1000` and reads UTC getters as the Beijing calendar; if `n >= WEEKEND_VALLEY_FROM_SEC` and `getUTCDay()` ∈ {0,6} → `false`; then `hour ∈ [start,end)` for any window.

### 4.4 Auto-used quota counter (`settings.models[id].quota`)

Defaults `qDef()` (**L996**): `{ on:false, mode:'auto', total:0, unit:'tokens', used:0, reset:'none', baseAt:0 }`.

Fields: `on` (bool), `mode` ∈ `'auto' | 'manual' | 'codex'`, `total` (number), `unit` ∈ `'tokens' | 'money'`, `used` (number), `reset` ∈ `'none' | 'daily' | 'monthly'`, `baseAt` (number, cumulative-token baseline). The UI adds a transient `resetBase` boolean that is **deleted before persisting** (L1028–1029) and converted into `baseAt = Number(apiUsageRaw(mid).tokensTotal) || 0` (L1032–1033).

`apiQuotaAutoUsed(id, q)` (**L1640–1664**), precedence:
1. `q.unit === 'money' && (q.mode === 'auto' || q.mode === 'codex')` → `Math.round(Number(q.used)||0)` — auto-accumulating tokens as money is meaningless, so it falls back to the manual value (and the UI hides the auto options, wid:2847).
2. `q.mode === 'codex'` → `codexSummaryCached()`; if unavailable, `base = Number(q.used)||0`; `reset==='daily'` → `round(cs.todayTokens)`; `'monthly'` → `round(cs.monthTokens)`; else `round(base + max(0, cs.totalTokens - baseAt))`.
3. `reset === 'daily'` → `round(u.eventTokens)`
4. `reset === 'monthly'` → `round(u.tokensMonth)`
5. default (no reset) → `round((Number(q.used)||0) + max(0, (Number(u.tokensTotal)||0) - baseAt))`; `q.used` here means "already used before installing".

`apiModelsPayload` enriches each entry: `entry.quota.autoUsed = apiQuotaAutoUsed(...)`, `entry.quota.autoToday = Math.round(Number((apiUsageRaw(id)||{}).eventTokens)||0)` (L1881–1884).

`writeUsageSettings({modelSettings:{id, alert, budget, quota}})` (L1019–1043) deep-merges alert/budget, **replaces** quota wholesale (`Object.assign({}, cur.quota||{}, q)`), and mirrors builtin `deepseek` back to the top-level `alert`/`budget` so legacy readers keep working (L1039–1042).

Per-model alert/budget defaults (L997–1006): the built-in reuses the top-level `alert`/`budget` (zero-migration), custom models get `Object.assign({}, usageSettingsDefaults().alert, st.alert||{})` etc.

### 4.5 Session-event attribution (L1666–1698)

`apiAttributeEvent(modelName, cost, tokens)`:
- lowercase the name; bail if empty
- first registry model where any of `matchIds` (fallback `[m.name, m.id]`), lowercased+trimmed, is a **substring** of the name → `hit`
- load-or-rollover `cur`; `cur.eventCost = addMoney(cur.eventCost||0, cost)`; `cur.eventTokens += tokens`
- `cur.tokensTotal += tokens`; if `cur.month !== todayKey().slice(0,7)` then `{ cur.month = mk; cur.tokensMonth = 0 }`; `cur.tokensMonth += tokens`
- persist; returns bool

`apiDeleteModel(id)` (**L1700–1745**): refuses `'deepseek'` (`'内置模型不可删除'`); removes the registry row and `reg.usage[id]`; sets `customPriceAt = 0`; deletes `led.settings.models[id]`; then walks the bubble config removing every `module.modelId === id` from `cfg.items[].modules` (recursing into `options[].item`) and from `cfg.lib[].module`; returns `{ok:true, removedModules: removed}`.

---

## 5. Accounting kernel — `accounting.mjs` (187 lines)

Header comment (acct:L1–2): *"Balance observations are not a transaction API. Keep them separate from token estimates and require explicit credits/debits for reconciliation."*

### 5.1 Fixed-point money — `SCALE = 100000000` (1e8, **8 decimals**)

- `moneyUnits(value)` (acct:L6–11): `Number(value)`; `units = Math.round(n * SCALE)`; throws `'金额无效或超出可记账范围'` unless `Number.isFinite(n) && Number.isSafeInteger(units)`.
- `preciseMoney(value)` (L13): `moneyUnits(value) / SCALE` — the canonical rounding/cleaning function (used before every write).
- `addMoney(a,b)` (L14): `sumMoney([a,b])`.
- `sumMoney(values)` (L15–20): accumulate integer units, throw `'金额合计超出可记账范围'` if the total leaves the safe-integer range, return `units / SCALE`.
- 8 decimals is the storage precision; the README states display is 2 decimals.

### 5.2 Dates

- `beijingDay(time = Date.now())` (acct:L22–26): `new Date(Number(time) + 8*3600000)`, throw `'无效的观测时间'` if NaN, return `d.toISOString().slice(0,10)`. UTC+8 fixed offset — no DST, no locale.
- `dayOffset(day, offset)` (L28–30): `beijingDay(Date.parse(day + 'T00:00:00+08:00') + offset*86400000)`.

### 5.3 Ledger shape & book selection

`currentBook(ledger)` (acct:L32–35): `ledger.accounting` must exist, have `version === ACCOUNTING_VERSION (1)`, and `books[active]` must be truthy.

```jsonc
"accounting": {
  "version": 1,
  "active": "<scope>-<CURRENCY>",     // e.g. "a1b2c3…-CNY"
  "books": {
    "<scope>-<CURRENCY>": {
      "currency": "CNY",
      "days": { "YYYY-MM-DD": DayRow },
      "lastAt": 1712345678901
    }
  },
  "migratedAt": 1712345678901,
  "legacyHistory": { "YYYY-MM-DD": number }
}
```

`DayRow` (acct:L96–99): `{ day, firstAt, lastAt, openingUnits, lastUnits, debitUnits, creditUnits, revision, correction }`. `correction` (L152–155) is `{ at, creditsUnits, otherDebitsUnits, amountUnits, debitUnits, creditUnits }` or `null`. `row.correctionLog` (L157–159) is an append-only audit trail of `{ at, previous, next }` **capped at 50** entries via `splice(0, len-50)`.

### 5.4 Observation — `observeBalance(ledger, snapshot)` (acct:L70–117)

Validates:
- `at = Number(snapshot.at ?? Date.now())`
- `day = beijingDay(at)`
- `units = moneyUnits(snapshot.balance)`
- `currency = String(snapshot.currency || 'CNY').toUpperCase()`; must match `/^[A-Z]{3}$/` else `'余额币种无效'`
- `scope = String(snapshot.scope || 'default')`; must match `/^[a-zA-Z0-9_-]{1,80}$/` else `'账户标识无效'`
- `context = scope + '-' + currency` ← **the per-account/per-currency isolation key**

Migration (L80–87): if there's no `accounting`, or `version !== 1`, a fresh root is created:
```js
a = ledger.accounting = { version: ACCOUNTING_VERSION, active: context, books: {}, migratedAt: at,
                          legacyHistory: { ...(ledger.history || {}) } }
```
The old `history` map is preserved under `legacyHistory` for reference because *"Legacy totals have no trustworthy recharge metadata"* — a new explicitly-timed observation window begins instead.

Book creation (L88–90): `a.books ||= {}`; `book = a.books[context] ||= { currency, days: {} }`.

Out-of-order guard (L91–92): `if (book.lastAt != null && at <= book.lastAt) return balanceSummary(ledger, ledger.date)` — duplicate or late samples (including one from yesterday) are ignored. `a.active = context` is set **after** the guard.

First sample of a day (L95–99): creates the row with `openingUnits = lastUnits = units`, `debitUnits = creditUnits = 0`, `revision = 0`, `correction = null`.
Subsequent samples (L100–106): `delta = row.lastUnits - units`; `delta > 0` → `debitUnits += delta` (**consumption**); `delta < 0` → `creditUnits -= delta` (**top-up/credit**); then `lastUnits = units; lastAt = at`.

`book.lastAt = at`; `ledger.date = day` (L107–108).

Compatibility fields (L109–111): `ledger.dayStart = row.openingUnits/SCALE`, `ledger.lastBalance = row.lastUnits/SCALE`.
Then `ledger.todayUsage = summary.amount`, `ledger.history[day] = summary.amount` (L112–116). Mutates the caller-owned ledger; the module never touches the filesystem (acct:L69).

### 5.5 Balance correction (余额校正)

`observedAmount(day)` (acct:L39–42):
```js
const c = day.correction
return (c ? c.amountUnits + day.debitUnits - c.debitUnits : day.debitUnits) / SCALE
```
Once corrected, the corrected `amountUnits` replaces the observed debits that were current at correction time; later debits still add on top.

`revisionOf(ledger, day)` (acct:L44–47): joins with `':'` — `[accounting.active, day.day, day.firstAt, day.lastUnits, day.debitUnits, day.creditUnits, day.revision || 0]`. This is the optimistic-concurrency token handed to the UI.

`reconcileBalance(ledger, input, now = Date.now())` (acct:L132–167):
1. `day = String(input.day||'')`; must match `/^\d{4}-\d{2}-\d{2}$/` else `'请选择有效的记账日期'`
2. `row = currentBook(ledger)?.days[day]`; missing → `'这一天没有余额观测记录，无法校正'`
3. `if (input.revision !== revisionOf(ledger,row))` throw `'余额或校正记录已更新，请重新打开校正窗口后核对金额'` with `err.status = 409`
4. `if (input.action !== 'reset' && input.confirmed !== true)` → `'请先确认已核对本统计区间的全部余额调整'`
5. If `action !== 'reset'`:
   - `creditsUnits = adjustmentUnits(input.credits, true)` (**required**)
   - `otherDebitsUnits = adjustmentUnits(input.otherDebits)` (optional, default 0)
   - **`amountUnits = row.openingUnits + creditsUnits - otherDebitsUnits - row.lastUnits`**
   - must be a safe integer `>= 0` else `'校正后消费为负或超出范围，请核对统计起点与累计到账金额'`
   - `correction = { at: Number(now), creditsUnits, otherDebitsUnits, amountUnits, debitUnits: row.debitUnits, creditUnits: row.creditUnits }` — snapshotting the observed counters at correction time
6. `row.correctionLog.push({ at, previous: row.correction, next: correction })`, capped at 50
7. `row.correction = correction` (null for reset); `row.revision = (row.revision||0) + 1`
8. Refresh `ledger.history[day]`, and `ledger.todayUsage` only if `ledger.date === day`

`adjustmentUnits(value, required = false)` (acct:L119–130): `''|null|undefined` → 0, or throw `'请填写本统计区间的累计到账金额，未充值请填 0'` when `required`; otherwise must match `/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/` else `'金额须为非负数，最多保留 8 位小数'`; `moneyUnits(value)`; negative → `'金额不能为负数'`. **The regex rejects negatives, leading zeros (except `0`), and >8 decimals** — it never silently rounds.

> Semantics: balance can only observe a **net** snapshot. Top-ups and consumption inside one refresh interval are indistinguishable, so recharge accounting must be explicit. That is exactly the 待核对 flow below.

### 5.6 "Balance increase detected → 待核对余额调整"

`balanceSummary(ledger, day = beijingDay())` (acct:L49–67):
```js
const needsReview = row.creditUnits > (correction ? correction.creditUnits : 0)
const source = needsReview ? 'balance-needs-review' : correction ? 'balance-corrected' : 'balance-observed'
```
i.e. **any observed credit not yet acknowledged by a correction** flags the day. Returns:
`{ day, amount: preciseMoney(observedAmount(row)), currency: book.currency, source,
   label: needsReview ? '已观测消费 · 待核对余额调整' : correction ? '已校正消费' : '已观测消费',
   firstObservedAt: row.firstAt, lastObservedAt: row.lastAt,
   openingBalance: row.openingUnits/SCALE, currentBalance: row.lastUnits/SCALE,
   observedDecrease: row.debitUnits/SCALE, observedIncrease: row.creditUnits/SCALE,
   needsReview, partialDay: true, revision: revisionOf(ledger,row),
   credits: correction ? correction.creditsUnits/SCALE : null,
   otherDebits: correction ? correction.otherDebitsUnits/SCALE : null,
   correctedAt: correction ? correction.at : null }`
`partialDay` is hard-coded `true` — the window is always a partial day. Returns `null` when there is no book/row.

### 5.7 Day summary & event estimate

`eventEstimate(ledger, day)` (acct:L169–172): `sumMoney(ledger.events.filter(e => e.day === day).map(e => Number(e.cost) || 0))`.
`daySummary(ledger, day)` (acct:L174–187): an observed summary wins and gains `{ eventEstimate: estimate, eventCurrency: 'CNY' }`. Otherwise it consults `ledger.accounting ? ledger.accounting.legacyHistory : ledger.history`; *"An explicit historical total (even zero) wins over a conflicting estimate"* — `hasHistory = typeof h === 'number' && Number.isFinite(h)`. Returns `{ day, amount: hasHistory ? preciseMoney(h) : estimate, currency:'CNY', source: hasHistory ? 'legacy' : 'events', label: hasHistory ? '旧版记录 · 未校正' : '本地估算', eventEstimate, eventCurrency:'CNY', partialDay:true }`.
`accountingDays(ledger)` (L37): `Object.keys(currentBook(ledger)?.days || {})`.

### 5.8 Atomic write + migration backup (index.js, not accounting.mjs)

`ledgerIo(operation)` (**L785–792**): retries the operation up to 6 times (attempt 0..5) when `err.code` ∈ `['EBUSY','EPERM','EACCES']`, sleeping via `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))` (blocking synchronous sleep: 20/40/60/80/100/120 ms). Comment: Windows indexers briefly hold a just-written file; **never treat an unreadable existing ledger as an empty ledger**.

`readUsageLedger()` (**L793–802**): for each candidate, parse (through `ledgerIo`); require an object with `typeof parsed.date === 'string'`, otherwise throw `'账本结构异常，已停止写入以保护原记录'`. `ENOENT` falls through to the next candidate; any other error propagates. All missing → `{ date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }`.

`writeUsageLedger(led)` (**L803–824**) — atomic:
1. `body = JSON.stringify(led)`, `temp = p + '.tmp-' + process.pid`
2. **Migration backup**: if `p` exists and its content has no `accounting` or `accounting.version !== 1`, copy it to `p + '.before-recharge-fix.bak'` with `fs.constants.COPYFILE_EXCL` (`EEXIST` tolerated) — L808–813
3. `fs.writeFileSync(temp, body)` then `fs.renameSync(temp, p)` (atomic replace on POSIX; best-effort on Windows)
4. on failure: delete the temp, log `'[whale-ledger] 账本保存失败:'` + `err.code || err.message` (unless `ENOENT`), continue to the next candidate
5. returns `true` on the first success, `false` if every candidate failed

`recordLedgerUsage(currentBalance, currency, scope, at)` (**L1991–1997**): read → `observeBalance(led, {...})` → `pruneLedgerUsage(led)` → `writeUsageLedger` or throw `'账本保存失败，请检查 DSH 数据目录写入权限'`. `getBalance(force)` (L2015–2039) calls it with `scope = payload.accountTag` = `sha256(apiKey).slice(0,24)` (L768) — so **the observation window is keyed by a hash of the API key plus the currency**, never the raw key.

Ledger writes are also triggered by `appendUsageEvent` (L888–901) and `writeUsageSettings` (L1009–1046).

### 5.9 Correction HTTP route (`/dsh-whale/balance-adjustments.json`, L2545–2601)

- Target must be exactly one `modelId` query param and it must be `'deepseek'` **and** `canAdjustBuiltinBalance(apiModelById(id))` (`L80–82`: `id === 'deepseek' && builtin === true && provider === 'deepseek'`), else `403` `'余额校正仅支持 DeepSeek（内置），请从该模型的设置菜单进入'`. New vendor templates and manually added same-named models never inherit this.
- `PUT`: body ≤8192 bytes via `readBodyMax(req, 8192)`; `input.modelId` must equal the query target else `403`; if `input.day === todayKey()` a **forced fresh** balance fetch must succeed and not be `stale`, else `503` `'暂时无法刷新余额，请稍后再保存校正'`; then `reconcileBalance(led, input)` → `writeUsageLedger` or throw `'校正保存失败，请检查 DSH 数据目录写入权限'`; `balanceCache = null`; responds `{ok:true, summary}`.
- `GET` (or no method): forced refresh + `{ ok:true, days: accountingDays(led).sort().reverse().map(day => balanceSummary(led, day)), today, fresh, error }`. Errors respond with `err.status || 400`.

---

## 6. Per-turn consumption tracking

State (L571–576): `turnAggs = new Map()` (`sessionId -> {turn, cost, tokens, byModel, byModelTokens, lastTs}`), `lastTurn`, `lastTurnSeq`, `disposers = []`. Bucketing by session id prevents main-session / subagent (spawn/fork) cross-contamination.

Subscriptions (L670–677):
```js
ctx.on('session/event', (session, event) => handleSessionEvent(session?.id || 'default', event))
ctx.on('session/disposed', (session) => { if (session?.id) turnAggs.delete(session.id) })
```

`handleSessionEvent(sessionId, event)` (**L620–667**), fully try/caught:
- `type === 'turn/end'` → `finalizeTurn(sessionId)`; return
- only `type === 'assistant/message'` proceeds; requires `event.data` object, a finite `d.turn`, and a `d.usage` object
- if there is no aggregate, or `agg.turn !== turn`, finalize the previous one and start `{ turn, cost:0, tokens:0, byModel:{}, byModelTokens:{}, lastTs: Date.now() }`
- token fields read (**L639–641**): `inputTokens`, `cacheReadTokens`, `outputTokens`
- **`outputBilled = output`** (L645) — reasoning tokens are **not** added separately because DSH guarantees `reasoningTokens ⊆ outputTokens` (`dsh-token-meter` rejects `reasoningTokens > outputTokens`). Adding them would double-bill the output side (~2× too high — issue #89 / PR #83).
- `toks = input + cache + outputBilled`; `agg.tokens += toks`
- model from `d.message?.source?.model` (L649)
- `refreshCustomPrices()` (10 s throttle) before pricing
- `p = priceFor(model)`; `off = isPeakTime(Math.floor(Date.now()/1000)) ? 1 : 0`
- **cost formula (L654)**: `costMsg = (cache/1e6)*p.hit[off] + (input/1e6)*p.miss[off] + (outputBilled/1e6)*p.out[off]`
- USD conversion (L656–659): if `customPriceMetaFor(model)` has `cur === 'USD' && rate > 0`, `costMsg *= rate` — **the ledger is always CNY**
- `agg.cost = addMoney(agg.cost, costMsg)`; per-model accumulation `agg.byModel[model] = addMoney(prev, costMsg)` and `agg.byModelTokens[model] += toks`; `agg.lastTs = Date.now()`

`finalizeTurn(sessionId)` (**L596–617**): only when `agg && agg.cost > 0`:
- `lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }`
- `lastTurnSeq++` then `writeTurnSeq(lastTurnSeq)`
- per model: `appendUsageEvent({ ts: agg.lastTs, model: mname, cost: byModel[mname], tokens: byModelTokens[mname]||0 })` **and** `apiAttributeEvent(mname, cost, tokens)` (registry attribution — the fallback for a model whose vendor balance delta is unavailable)
- no models → `appendUsageEvent({ ts, model:'未知', cost: agg.cost, tokens: agg.tokens })`
- always `turnAggs.delete(sessionId)`

### seq file `.dshw-turn.json`
`readTurnSeq()` (L579–587): first candidate whose JSON has `typeof seq === 'number' && seq >= 0`; else `0`. `writeTurnSeq(seq)` (L588–593): `JSON.stringify({ seq, updatedAt: new Date().toISOString() })` → first writable candidate. Initialized at plugin load `lastTurnSeq = readTurnSeq()` (L594). Purpose (L578): after a hot reload/restart the seq keeps increasing so the frontend can't mistake a new turn for an already-consumed old one.
Route `/dsh-whale/last-turn.json` (L2463–2474) returns `{ok:true, seq, turn, amount, tokens, ts}`, or all-null with `seq: 0`.

### Ledger event record
`appendUsageEvent(ev)` (**L888–901**): read → push → `pruneLedgerUsage` → write.
```js
{ ts: Number(ev.ts) || Date.now(),
  day: dayKeyFromTs(ts),                 // beijingDay
  model: String(ev.model || '未知'),
  cost: preciseMoney(Number(ev.cost) || 0),
  tokens: Math.round(Number(ev.tokens) || 0) }
```

### Aggregation payload
`usageRecordsPayload()` (**L903–940**), `version: '0.3.5'`:
- `modelsFor(day)` groups events by model into `{model, cost, source:'events', currency:'CNY'}`, sorted by descending cost
- `forDay(date)` = `daySummary(led, date)` + `{date, total: summary.amount, models, modelTotal: sumMoney(models.cost), modelCurrency:'CNY'}`
- `today`, `days7` = the last 7 days (`Array.from({length:7}, (_,i) => forDay(dayAdd(today,-i)))`), `total7ByCurrency` accumulated per currency, `total7` + `total7Currency` for today's currency
- `all.days`: union of `today`, `Object.keys(led.history)`, `accountingDays(led)`, and every valid `YYYY-MM-DD` event day — filtered, ascending sort then reversed (newest first)
- `all.events`: newest-first, `slice(0, 500)`
- `settings: readUsageSettings()`

---

## 7. Codex local session statistics

Data source (L1047–1054): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/*.jsonl` — plaintext JSONL. Never writes to `~/.codex`; **no credentials involved**.

`codexHome()` (L1055–1061): `process.env.CODEX_HOME` trimmed, else `path.join(os.homedir(),'.codex')`; first that `existsSync` wins; else `''`.

`readCodexCache()` (L1062–1068): `$DSH_HOME/.dshw-codex.json`; valid only if `j.files` is an object; else `{version:1, files:{}}`.
`writeCodexCache(c)` (L1069–1071): plain `writeFileSync` (not atomic), returns bool.

`listCodexSessionFiles(root)` (L1072–1087): recursive `walk(dir, depth)`, **depth limit 6**, readdir with `withFileTypes`; directories recurse; files matching `/^rollout-.*\.jsonl$/i` are collected. Roots: `root/sessions` and `root/archived_sessions`, both at depth 0. readdir errors are swallowed.

`parseCodexFile(file)` (**L1089–1155**) → `{ days, rl, rlTs }`:

Parsing loop:
- `text.split('\n')`; skip any line whose `charCodeAt(0) !== 123` (must start with `{`) — L1104
- `JSON.parse` per line; failures skipped
- requires `o.payload`; `type === 'turn_context'` → `if (p.model) model = String(p.model)` then `continue` — this is the running model attribution
- only `o.type === 'event_msg' && p.type === 'token_count'` proceed; requires `p.info` object
- `last = info.last_token_usage || null`, `tot = info.total_token_usage || null`
- `ts = Date.parse(String(o.timestamp || '')) || 0`; `!ts` → skip; `day = dayKeyFromTs(ts)`

Delta logic (L1122–1133) — prefers the **cumulative difference** because `total_token_usage` is monotonic and therefore immune to multiple `token_count` events in one turn:
```js
const totAll = tot ? Number(tot.total_tokens) || 0 : 0
if (totAll > 0) { delta = (prevTotal === null || totAll < prevTotal) ? totAll : totAll - prevTotal; prevTotal = totAll }
if (delta === null || delta <= 0) { if (!last) continue; delta = Number(last.total_tokens) || 0 }
if (delta <= 0) continue
```
Note `prevTotal` is per-file and a decrease (`totAll < prevTotal`) resets to the absolute value rather than going negative.

Splitting (L1134–1146): `lTotal = Number(last.total_tokens)||0`; `k = (lTotal > 0 && last) ? delta/lTotal : 0`; scaled+rounded fields from `last_token_usage`:
`in ← input_tokens`, `cached ← cached_input_tokens`, `cwrite ← cache_write_input_tokens`, `out ← output_tokens`, `reason ← reasoning_output_tokens` — each `Math.round(value * k)`. When `!last || k <= 0` all five are 0.

`bump(day, mk, v)` (L1096–1102) accumulates into `days[day][model]` with the key set `{ in, cached, cwrite, out, reason, total, turns }` — `total += delta`, `turns += 1`. Model key defaults to `'codex'` (L1091).

Rate limits (L1147–1152): `rl = p.rate_limits`; **only kept when it's an object and any of `rl.primary`, `rl.secondary`, `rl.plan_type`, `rl.credits` is truthy** (a null/empty provider yields nothing); the latest by `ts >= rlTs` wins.

`codexSummary()` (**L1197–1262**):
- no home → `{ok:false, error:'未找到 Codex 目录（$CODEX_HOME 或 ~/.codex）'}`
- **incremental cache**: keep the cached entry when `prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.days`; otherwise re-parse and store `{size, mtimeMs, days, rl, rlTs}`; `changed++`. `statSync` failures skip the file.
- persists when `changed > 0` or the file count differs: `{version:1, files: keep, builtAt: Date.now()}`
- `today = dayKeyFromTs(Date.now())`, `month = today.slice(0,7)`
- aggregation: `byDay[day] = { tokens, turns, models: {model: tokens} }`; `byModel[m] = { tokens, out, reason, cached, turns }`; running totals `totalTokens, todayTokens, monthTokens, outTokens, reasonTokens, cachedTokens`
- `days7`: 7 entries `{date, tokens, turns}` from `dayAdd(today, -i)`, i=0..6 (today first)
- `bestRl`/`bestRlTs`: highest-`rlTs` rate-limit snapshot across all files
- returns `{ ok:true, home, sessions: files.length, changed, todayTokens, monthTokens, totalTokens, outTokens, reasonTokens, cachedTokens, days7, byModel, rateLimits: bestRl, windows: normalizeCodexRateLimits(bestRl), rateLimitsTs }`
- **Note**: `cwrite` is stored per day/model in the cache but is never aggregated into the summary output.

`normalizeCodexWindow(w)` (**L1157–1183**) — tolerant of Codex version drift. `pick(keys)` returns the first finite `Number(raw)` skipping `null|undefined|''`.
- used%: `['used_percent','usedPercent','percent','used_pct','usage_percent','usagePercent']`
- remaining%: `['remaining_percent','remainingPercent','left_percent','remaining_pct']`; `usedPct = max(0, 100 - remainPct)` if used% is null
- relative reset: `['resets_in_seconds','resetsInSeconds','reset_after_seconds','reset_in_seconds','seconds_until_reset']` → `resetAt = Date.now() + secs*1000`
- else absolute: `w.resets_at || w.reset_at || w.reset_time || w.next_reset || w.resetAt || w.nextResetTime`; number `< 1e12` → `*1000`, else raw ms; string → `Date.parse`
- `windowMinutes` from `['window_minutes','windowMinutes','window','period_minutes']`
- `label` from `w.limit_name || w.name || w.label || w.window_name || ''`
- returns `null` when both `usedPct` and `resetAt` are null; else `{ usedPct, resetAt, windowMinutes, label }`

`normalizeCodexRateLimits(rl)` (**L1184–1195**): `{primary, secondary}` normalized (null when both fail), plus `planType = String(rl.plan_type || '')`, `limitName = rl.limit_name ? String(...) : (rl.limit_id ? String(...) : '')`, `reached = rl.rate_limit_reached_type ? String(...) : ''`.

Caching layers (L1263–1289): `codexSummaryCached()` memoizes for **5000 ms** (`codexMemo`, `codexMemoAt`). Prewarm: `setTimeout(..., 1500)` once plus `setInterval(..., 5*60*1000)`; both handles are stored, `unref()`ed, and pushed into `disposers` — without this the process would refuse to exit (issue #109).

### Codex cache file shape
```jsonc
{ "version": 1,
  "files": { "<abs path>": { "size": 12345, "mtimeMs": 1712345678901,
                             "days": { "YYYY-MM-DD": { "<model>": { "in":0,"cached":0,"cwrite":0,"out":0,"reason":0,"total":0,"turns":0 } } },
                             "rl": { /* raw rate_limits */ } | null, "rlTs": 1712345678901 } },
  "builtAt": 1712345678901 }
```
No credentials are ever stored (L1054).

### Codex consumption of quota
`apiQuotaAutoUsed` mode `'codex'` (L1649–1657) reads `codexSummaryCached()` and maps `reset` → today/month/cumulative-vs-`baseAt`. `apiProbeModel` for `kind==='codex'` (L1428–1434) reports today/month/total without network or key. `apiModelsPayload` computes `codexStats` **once per request** and attaches it to every codex-kind model (L1867, L1925–1930) — machine-level data shared across models.

---

## 8. Retention rules

`pruneLedgerUsage(led)` (**L844–883**) — returns `true` when it actually trimmed (caller then writes):
- `dateCut90 = dayAdd(todayKey(), -90)`, `dateCut365 = dayAdd(todayKey(), -365)`
- **events**: drop when `day && day < dateCut90` (string comparison on `YYYY-MM-DD`) into `dropEv`
- **events count cap**: if the survivors exceed **20000**, the excess is `keepEv.splice(0, keepEv.length - 20000)` — i.e. the **oldest** are dropped (relies on `events` being append-ordered)
- **history**: every key `< dateCut365` moves into `dropHist` and is `delete`d from `hist`
- if nothing dropped → `return false` (no write)
- archive merge: `readUsageArchive()`; append `dropEv` to `ar.events`; **archive events cap 200000** (`splice(0, len-200000)`); `ar.history = Object.assign({}, ar.history || {}, dropHist)`; set `ar.updatedAt = new Date().toISOString()`; set the literal `ar.note = '小鲸鱼记账归档：events 超 90 天或超 2 万条、history 超 365 天的部分'`
- write the archive with a plain `writeFileSync`; **any throw inside the try → `return false`, and crucially `led.events`/`led.history` are only reassigned after the archive write succeeds** (L879–881) — so a failed archive never loses data
- archive read fallback: `{ version: 1, events: [], history: {} }` (L841)

`usageArchivePath()` (L827–835): the first candidate whose **directory** is `W_OK` → `<dir>/.dshw-usage-archive.json`; fallback `path.join(DSH_HOME, '.dshw-usage-archive.json')`.

Summary table:

| Data | Retention | Overflow destination |
|---|---|---|
| `events` (per-turn detail) | 90 days **and** ≤ 20000 records | `.dshw-usage-archive.json` `events[]` |
| archive `events` | ≤ 200000 records | oldest silently dropped |
| `history` (per-day totals) | 365 days | `.dshw-usage-archive.json` `history{}` |
| `accounting.books[*].days` | **not pruned** | — (only `ledger.history` is) |
| `row.correctionLog` | last 50 entries | older dropped (acct:L159) |
| `ledger.settings.models` | not pruned | removed by `apiDeleteModel` |
| `.dshw-api.json` `usage[id]` | current day only (+ cumulative counters) | — |

`pruneLedgerUsage` is called from `appendUsageEvent` (L899) and `recordLedgerUsage` (L1994) — **never** from `writeUsageSettings`.

---

## 9. Porting checklist / invariants

1. Money is stored as integer 1e-8 units; use `moneyUnits`/`preciseMoney`/`addMoney`/`sumMoney` everywhere and never raw float addition. `Number.isSafeInteger` guards are load-bearing.
2. All day keys are Beijing (UTC+8) `YYYY-MM-DD` strings; all ordering comparisons are lexicographic.
3. The observation window key is `scope + '-' + currency`, where scope is the API-key hash (`sha256(key).slice(0,24)`) — **never key a book by currency alone**.
4. Duplicate/out-of-order samples (`at <= book.lastAt`) must be dropped, not merged.
5. Credits increase `creditUnits` and never reduce `debitUnits`; `needsReview` stays true until an explicit correction acknowledges them.
6. The ledger write must be temp-file + `rename`, with the `.before-recharge-fix.bak` migration copy guarded by `COPYFILE_EXCL`.
7. `pruneLedgerUsage` must write the archive **before** mutating the in-memory ledger, and must return false on any failure.
8. Turn cost: `cache*price.hit + input*price.miss + output*price.out`, all per 1e6 tokens, with `output` already including reasoning; USD prices converted by `rate` before entering the CNY ledger.
9. `apiSaveModel` should additionally persist `matchIds` when porting (upstream drops it).
10. `writeApiRegistry` should be made atomic (temp + rename) when porting; upstream is not.
11. `.dshw-api.json` reads must tolerate a missing `usage` key; a corrupt file currently resets the whole registry silently — consider surfacing that error.
12. The `kind:'codex'` path must remain credential-free and must never write into `~/.codex`.
