# dsh-memory

DSH Web GUI 的长期记忆插件。双半边：

- **Host**（`lib/index.js`，预构建 ESM）——记忆注入、`memory_read` / `memory_write`
  模型工具、会话开始时检查并创建工作区记忆文件、设置面板 RPC。
- **Client**（`lib/client.js`，预构建 `__ModuleLoader__` bundle）——设置页
  「记忆」分区，查看 / 编辑全局 `agent.md`。

## 记忆落在哪

| 范围 | 文件 |
|---|---|
| 全局（跨工作区） | `$DSH_HOME/agent.md`（默认 `~/.dsh/agent.md`） |
| 工作区 | `<cwd>/.agent/memory.md`（会话开始时自动创建为空文件） |

注入走 `agent/pre-step`：每个会话只在**首次成功注入**时插入一条带
`source.kind = 'plugin:dsh-memory'` / `form = 'snapshot'` 的 user 上下文消息
（`source.kind` 必须是「生产者自有」的 kind，用裸 `'plugin'` 会被会话日志 v4 的
`SessionFormatError` 拒收），之后不再重复注入（像系统提示词一样只有一份）。
子代理不注入。**注入失败或内容残缺时不锁定**，下一轮会重试——绝不出现"标记已生效
但记忆没进上下文"的静默浪费（详见变更记录 1.3.0）。文件读盘只在 `agent/created`
发生一次，会话中途的外部改动需要模型自己调 `memory_read` 现读。

**已知边界**：`/compact` 压缩不会重建 agent（走 `agent.runMaintenance`），所以不会
重复注入；但记忆消息作为普通 `user` 消息落在 surface 头部，压缩时可能被 summary
覆盖。若在意可在压缩后让模型调 `memory_read` 重新读一次。

## 形态：bundle，不是手工挂载的静态包

这个包是 **profile bundle**：`package.json` 里声明 `dsh.bundle.patch` 指向自带的
`cordis.patch.yml`，由它自己往 profile roster 里插入插件行；profile 侧只需要把包装进
`dsh.profile.bundles`：

```bash
dsh plugin --profile web add link:F:/ds_global/dsh-web-ui/my-plugins/dsh-memory
```

同族的 `dsh-recent-tabs` / `dsh-wip-board` / `dsh-plugin-manager` 都是这个形态。
（历史形态是「静态包 + 在 profile 的 `cordis.patch.yml` 里手写 `insert` 行」，
已被取代：那种包不受 pnpm 管理、不在 `dsh.profile.bundles` 里，profile 重建就会丢。）

## 改动与生效

`lib/` 是**手工维护的预构建产物**，没有 src / 构建链——直接改 `lib/*.js`：

| 改了 | 生效方式 |
|---|---|
| `lib/client.js` | 刷新 GUI 页面（bundle 内容变更需要 dsh web 重新快照，稳妥做法是重启） |
| `lib/index.js` | **必须重启 dsh web**（host 半边在进程启动时 require 一次） |

## 变更记录

### 1.5.0 — 记忆上限收紧为 20 条 / 5000 字，超限 add 直接拒绝（硬闸门）

1.4.0 的预算只是**事后提示**：写入后才报「已超预算」，文件照样一路堆到 40+ 条 /
上万字，每次会话注入占用的上下文越来越大。用户要求「累加到一定字符数就得去整理
合并，必要时整份重写」。

- **改**：`MEMORY_BUDGET` 从 `{ entries: 40, chars: 8000 }` 收紧为
  `{ entries: 20, chars: 5000 }`。
- **改**：`memory_write` 的 add 在**写入前先算结果**，整份超过 20 条 / 5000 字时
  **直接拒绝写入**并返回当前条数/字数，提示先 `action=rewrite` 整理合并全文或
  `action=remove` 删减，降到限内才能继续写。rewrite / remove 不受此闸门限制
  （它们正是整理手段）。
- **改**：工具描述同步新上限与硬闸门说明。
- 备份：`lib/index.js.bak-before-limit-20261124`。**生效需重启 dsh web**。

### 1.4.0 — 重写 `memory_write` 提示词：把「记什么」放回第一顺位，并给预算加上可观测反馈

现象：记忆文件持续膨胀、且出现**同一事实的平行条目**（例：`F:\deepseekharness\.agent\memory.md`
第 6-10 行与 11-16 行是同一段项目结构写了两遍，第二遍只在第一条后追加了半句）。
`F:\ds_global\.agent\memory.md` 一度到 48 条 / 10196 字。

根因不在模型"爱记流水账"，而在提示词本身：

1. **诱饵**：建议节 `项目结构与关键路径` 明确写着「目录/文件映射、分层」，等于直接
   指挥模型去记目录树——既是最快腐烂的内容，也是体积主来源。
2. **位置错**：「不记流水账、保持精简」只有一句，埋在 688 字的工具用法说明末尾。
   模型读工具描述是为了知道**怎么调用**，不是读价值观，这句实际上没被消费。
3. **无判据**：「保持精简」不可执行。缺"该不该记"的可判定测试，缺负例，缺默认值。
4. **无反馈**：写入只回「已写入记忆」，模型无从知道自己是否已超量，自然只会 add。

改法：

- description 从单行长字符串改为 `[...].join('\n')` 多行（688 字 → 约 1500 字，结构可读、后续好改）。
- 首段改为定位句「写给下一个会话的自己」，并点明成本：**每条记忆每次新会话都会全文注入**。
- 新增**【写之前三问】**（可复用 / 不可推导 / 改变做法，全过才写；拿不准就不写）。
- 新增**【必须记】/【绝对不记】**双侧清单，负例具体到句式（日期前缀、目录树、
  一次性排查过程、临时状态、「本次改动完成了」）。
- 新增**【预算】**：单条 ≤2 行 120 字、单节 ≤12 条、整份 ≤40 条；同一事实只允许一处。
- 新增**【add 之前必须做的事】**：先 read 查重，相近则改写旧条；「相近」按主题不按措辞。
  这条直指平行条目这个真问题。
- `项目结构与关键路径` 的说明改为「只记非显然的约定和迁移约束，不写目录树、不写文件清单」。
- **新增可观测反馈**：`memory_write` 成功消息追加 `（当前 N 条 / M 字）`，超
  `MEMORY_BUDGET = { entries: 40, chars: 8000 }` 时追加「已超预算…请先合并或删减」。
  只提示不拒绝——拒绝写入会打断正常流程，先让模型看见数再说。
- 实测基线（本机）：`ds_global` 48 条 / 10196 字（超）；`deepseekharness` 13 条 / 2183 字；
  `doc-gen` 24 条 / 4281 字；全局 `agent.md` 2 条 / 1103 字。

备份：`lib/index.js.bak-before-prompt-20261020`。**生效需重启 dsh web**。

### 1.3.0 — 修「每会话只注入一次」的标记时序，防止记忆被白白浪费

1.2.0 的注入标记在 `agent/pre-step` 里**消息构造之前**就被 set。这带来一类静默浪费：
**只要消息构造阶段出一次意外（数组操作失败、surface 异常等），标记已经生效但记忆
没进上下文**，本会话永久失忆且不会重试——用户感知就是"随便干点什么，记忆就没了"。
实测确认修复前存在两条必现路径（构造异常、读盘失败）。

- **修**：标记改为 `'complete' / 'partial' / 无` 三态，且**只在消息构造成功返回后**
  才 set。整段构造包在 try 里，任何异常都原样返回 `decision`（不注入、不打标记），
  下一轮自动重试。这是本文件最重要的不变量。
- **修**：注入不完整时记为 `'partial'` 而不是 `'complete'`，后续步骤会继续尝试补齐，
  不再把残缺内容当成完成态锁死。两种残缺：拿不到 `cwd`（会话头异常）、
  工作区记忆读盘失败。
- **修**：`loadInto` 不再吞异常后返回，改为把错误抛给调用方；`ensureMemoryLoaded`
  返回 `{ loadFailed }`，让上层能区分「文件本来就没有」和「读盘失败」。
  `agent/created` 里全局与工作区**分别兜底**，一方失败不拖累另一方。
- **防抖**：工作区记忆确实为空是合法状态，用「连续 3 步为空才算本来就没有」的计数器
  收敛——既不会每次都白试，也不会无限重试。成功读到时清零计数。

### 1.2.0 — 修记忆写入的三处数据损坏风险

- **修**：`insertEntry` 会把原节标题替换成调用方传的 `section` 名。原代码
  `target.length = 0` 清空数组后再读 `target[0]`，拿到的必然是 `undefined`，
  于是 `target[0] || ('## ' + sectionName)` 永远走右边——**每写一条记忆就把节标题
  改短一次**（`## 常见坑（避坑档案）` → `## 常见坑`）。现在先取出原标题再清空。
- **修**：`section` 匹配从双向 `includes` 模糊匹配改为**完全相等**。原先
  `section='工具'` 会命中 `## 工具与环境`，叠加上面那条 bug 就把标题截断；
  两个节都匹配时还会取第一个。现在匹配不上就另建新节。
- **修**：`memory_write action=remove` 一次会删掉**所有**含关键词的条目
  （传 `pymssql` 连带删 2 条，属静默数据丢失）。现在先扫命中数，
  **命中 > 1 条时拒绝写文件**并返回全部命中条目，要求调用方收窄关键词后重试。
- **修**：删除逻辑的标题判据从 `/^#/` 收紧为 `/^#{1,6}\s/`，正文里的 `#1`、
  `#hashtag` 不再被误判成标题（否则会错误终止「跳过失行」状态，把该一起删的续行留下）。
- **修**：`splitBlocks` 把首个 `## ` 之前的连续行合并成一个 preamble 块，
  修掉 `memory_read` 全量返回时前言区被 `join('\n\n')` 撑出空行的问题。
- **修**：`injectedAgents.set` 从「渲染文本前」移到「文本非空后」，两个记忆文件
  都为空时不再永久废掉该会话的注入。
- **修**：`loadInto` 的并发去重从「命中 loading 直接 return」改为复用在飞的
  Promise 并等待，消除读到未填充 cache 的竞态。
- **改**：`FULL_POLICY.workspaceRoot` 不再写死 `C:\\`，按 `process.platform` 推导。
- **改**：工具描述同步说明 remove 的唯一命中要求与 section 需精确匹配。
- **清**：移出插件目录里的 `package.json.orig-backup` 残留（1.0.0 旧版）。

### 1.1.0 — 对齐 dsh 0.1.6-alpha.2

- **修**：`agent/session-start` 事件在 0.1.6 的 `agent/*` 事件集里已不存在
  （现为 `created` / `disposed` / `error` / `pre-step` / `request` / `request-error` /
  `status` / `turn-stopping` / `assistant-stream`）。该监听器因此静默失效，
  「会话开始时刷新全局记忆 + 自动创建并加载工作区 `.agent/memory.md`」整段逻辑不再执行
  （症状：工作区里根本没有 `.agent/` 目录）。改为监听 **`agent/created`**
  （payload 为 `{ agent, source, signal }`）。
- **改**：注入形态从「静态包 + profile 手写 `insert`」改为 **自注册 bundle**
  （`dsh.bundle.patch` + `dsh.profile.bundles`），与 `dsh-recent-tabs` 一致。
