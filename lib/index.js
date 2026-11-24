// dsh-memory — host half (bundle package, plain ESM)
// 长期记忆：全局 $DSH_HOME/agent.md + 工作区 .agent/memory.md 注入、
// memory_read / memory_write 模型工具、会话创建时自动检查/创建工作区记忆文件、
// 设置面板 RPC（webServer 前缀路由）。
// 注册形态：自注册 bundle —— 见同目录 cordis.patch.yml + package.json 的 dsh.bundle.patch。
// 改本文件后必须重启 dsh web（host 半边在进程启动时 require 一次）。
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// 与 @deepseek-ai/dsh-llm 的 createUserMessage 一致：注入消息发布前深度冻结。
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o)) deepFreeze(o[k])
  }
  return o
}

function dshHomePath() {
  const raw = process.env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const h = raw.trim()
    const expanded = h === '~' ? homedir() : h
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(homedir(), '.dsh')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

export default {
  apply(ctx) {
    ctx.inject(['fs', 'tools', 'webServer'], (c) => {
      const fs = c.get('fs')
      const tools = c.get('tools')
      const webServer = c.get('webServer')
      if (fs === undefined || tools === undefined || webServer === undefined) {
        console.error('[dsh-memory] required services missing (fs/tools/webServer); plugin inactive')
        return
      }

      const GLOBAL_FILE = 'agent.md'
      const WS_REL = '.agent/memory.md'
      const GLOBAL_KEY = 'global'

      const cache = new Map()
      // 记录进行中的加载 Promise：同一 key 并发时复用一个已在飞的 Promise 并等待它，
      // 而不是直接 return。早期版本用 loading Set 命中即 return，调用方 await 到的是
      // 空操作，cache 可能尚未填充，导致本轮注入读到空记忆。
      const inflight = new Map()
      // 每个会话（agent 对象）记录注入状态；agent 释放后条目自动回收。
      // 值：'complete' = 已完整注入不再注入；'partial' = 只注入了全局部分，后续步骤
      // 仍会尝试补齐工作区记忆；键不存在 = 尚未注入。
      const injectedAgents = new WeakMap()
      // cwd -> 连续「工作区记忆为空」的次数，用于区分「读盘失败」与「本来就没有」。
      const missCounters = new Map()

      const keep = (fn, name) => ctx.effect(fn, name)
      // 本机以 danger-full-access 运行；显式声明策略，避免 fs 沙箱包装回落到 workspace-write。
      // workspaceRoot 取当前平台根目录（Windows 'C:\\'，POSIX '/'），不写死盘符。
      const FULL_POLICY = {
        mode: 'danger-full-access',
        workspaceRoot: process.platform === 'win32' ? 'C:\\' : '/',
      }
      async function writeTextSafe(pathStr, content) {
        const target = await fs.resolve(pathStr)
        await fs.writeText(target, content, undefined, undefined, FULL_POLICY)
      }

      function cwdOf(agent) {
        try {
          const h = agent && agent.session && agent.session.header
          if (h && h.cwd) return String(h.cwd)
        } catch (e) { /* ignore */ }
        return undefined
      }
      function isSubagent(agent) {
        try {
          const h = agent && agent.session && agent.session.header
          return !!(h && (h.origin === 'subagent' || (h.delegationDepth || 0) > 0))
        } catch (e) { /* ignore */ }
        return false
      }
      function wsKey(cwd) { return 'ws:' + cwd }
      function wsPath(cwd) {
        const base = String(cwd).replace(/[\\/]+$/, '')
        const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
        return base + sep + WS_REL.replace(/\//g, sep)
      }
      function globalPath() { return join(dshHomePath(), GLOBAL_FILE) }

      async function readText(pathStr) {
        const target = await fs.resolve(pathStr)
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return ''
        return await fs.readText(target)
      }
      // 从磁盘载入到 cache。**失败时抛错**而不是静默吞掉：调用方要靠这个信号区分
      // 「文件本来就没有」和「读盘失败」——后者必须允许下一轮重试，绝不能当成
      // 已经处理完那样锁定注入状态。早期版本在这里 console.error 后继续，
      // 于是读盘失败会被上层误判为「工作区记忆本来就没有」，白白锁死本会话注入。
      async function loadInto(key, pathStr) {
        const existing = inflight.get(key)
        if (existing) return existing
        const p = (async () => {
          const text = await readText(pathStr)
          cache.set(key, { text, path: pathStr })
        })().finally(() => { inflight.delete(key) })
        inflight.set(key, p)
        return p
      }
      async function ensureWorkspaceMemory(pathStr) {
        try {
          const target = await fs.resolve(pathStr)
          const info = await fs.stat(target)
          if (info && info.type === 'file') return
          await writeTextSafe(pathStr, '')
        } catch (e) {
          console.error('[dsh-memory] ensure workspace memory failed', e && e.message)
        }
      }

      loadInto(GLOBAL_KEY, globalPath())

      // 每次会话开始：刷新全局记忆；自动检查/创建当前工作区 .agent/memory.md（空文件）
      // dsh 0.1.6 的 agent/* 事件集里已经没有 `agent/session-start`（现为 created /
      // disposed / error / pre-step / request / request-error / status /
      // turn-stopping / assistant-stream），继续监听旧名会静默失效，导致工作区
      // .agent/memory.md 不再自动创建。改挂 `agent/created`（payload: agent/source/signal）。
      keep(() => ctx.on('agent/created', async (payload) => {
        const agent = payload && payload.agent
        const cwd = cwdOf(agent)
        // 全局与工作区分开兜底：一方失败不影响另一方加载成功。
        loadInto(GLOBAL_KEY, globalPath()).catch((e) => {
          console.error('[dsh-memory] load global failed', e && e.message)
        })
        if (cwd) {
          const pathStr = wsPath(cwd)
          await ensureWorkspaceMemory(pathStr)
          loadInto(wsKey(cwd), pathStr).catch((e) => {
            console.error('[dsh-memory] load workspace failed', e && e.message)
          })
        }
      }), 'dsh-memory: session-start')

      // 记忆读取：确保当前缓存就绪（首步注入前 await，避免首次加载竞态），再组装文本。
      // 返回 loadFailed 标记：读盘失败时上层必须保留重试机会，不能锁定注入完成态。
      async function ensureMemoryLoaded(agent) {
        const cwd = cwdOf(agent)
        let loadFailed = false
        const tryLoad = async (key, pathStr) => {
          try { await loadInto(key, pathStr) }
          catch (e) {
            loadFailed = true
            console.error('[dsh-memory] load failed', key, e && e.message)
          }
        }
        if (cwd && !cache.has(wsKey(cwd))) await tryLoad(wsKey(cwd), wsPath(cwd))
        if (!cache.has(GLOBAL_KEY)) await tryLoad(GLOBAL_KEY, globalPath())
        return { loadFailed }
      }
      function renderMemoryText(agent) {
        const cwd = cwdOf(agent)
        const parts = []
        const g = cache.get(GLOBAL_KEY)
        if (g && g.text) parts.push('【全局记忆 agent.md】\n' + g.text)
        if (cwd) {
          const w = cache.get(wsKey(cwd))
          if (w && w.text) parts.push('【本工作区记忆 .agent/memory.md】\n' + w.text)
        }
        return parts.join('\n\n')
      }
      // 判断这次注入是否「本该有的都注入了」。
      // -拿不到 cwd：工作区记忆无从读取，不算完整（可能是会话头信息异常，下次还能补）。
      // - 拿得到 cwd 但工作区记忆为空：分两种情况——读盘失败（loadInto 已console.error
      //   但cache 为空）或文件确实为空。前者不该锁定，后者在会话开始时已被
      //   ensureWorkspaceMemory 建成空文件，属正常，用「连续失败计数」兜底而不是
      //   永久锁死：连续 3 步都缺工作区记忆就认定为「本来就没有」，锁定 complete，
      //   避免每轮都白试一次、也避免无限重试。
      function isCompleteInjection(cwd) {
        if (cwd && cache.get(wsKey(cwd)) && cache.get(wsKey(cwd)).text) {
            missCounters.delete('wsmiss:' + cwd)
            return true
          }
        if (!cwd) return false
        const missKey = 'wsmiss:' + cwd
        const n = (missCounters.get(missKey) || 0) + 1
        missCounters.set(missKey, n)
        if (n >= 3) {
          console.warn('[dsh-memory] 工作区记忆连续 3 步为空，视为本来就没有，锁定注入完成态：' + wsPath(cwd))
          return true
        }
        return false
      }

      // 记忆注入：彻底退出系统提示词。每个会话（按 agent 对象标记）只在首次成功进入
      // 步骤时注入一次当前记忆快照，作为一条带来源的 user 上下文消息插入（等价于
      // “会话开始时固定调用一次 memory_read”）；之后同一会话的连续对话不再注入
      // （像系统提示词一样只有一份）。写记忆不会触发 in-history 系统提示词追加；
      // 会话内记忆变更后需要最新内容时走 memory_read 按需读取。子代理不注入。
      //
      // 打标记的时机是这个 handler 的关键不变量：**必须等消息真正构造并返回成功之后
      // 才 set**。早期版本在构造之前就 set，于是「消息构造阶段任何一次异常」都会留下
      // 一个空标记——记忆没进上下文、标记却已生效，本会话永久失忆且不会重试。
      keep(() => ctx.on('agent/pre-step', async (payload, next) => {
        const agent = payload && payload.agent
        if (!agent || isSubagent(agent)) return next()
        const state = injectedAgents.get(agent)
        // complete=已完整注入；partial=上次因缺 cwd / 读盘失败只注入了全局部分，
        // 后续步骤要继续尝试补齐，缺的东西补上之前不消耗这次机会。
        if (state === 'complete') return next()
        const decision = await next()
        if (decision.kind === 'reject' || (payload.signal && payload.signal.aborted)) return decision
        const { loadFailed } = await ensureMemoryLoaded(agent)
        if (payload.signal && payload.signal.aborted) return decision
        const text = renderMemoryText(agent)
        // 两份记忆都空时不打任何标记：否则本会话后续即使有了记忆也不会再注入。
        if (!text) return decision
        const cwd = cwdOf(agent)
        // 构造成功前绝不 set（见上方不变量说明）。下面整段用 try 包住，任何异常都
        // 原样返回 decision（不注入、也不打标记），下一轮会重试。
        try {
          const memMessage = deepFreeze({
            id: 'dsh-memory:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10),
            role: 'user',
            content: [{ type: 'text', text }],
            source: {
              // 会话日志 v4（dsh 0.1.7 起）要求 source.kind 是「生产者自有」的 kind：
              // 老的 { kind: 'plugin', plugin } 包装会被 SessionFormatError 拒收，
              // 症状是整轮对话失败：format v4 message requires a producer-owned source kind。
              // 官方 v3→v4 迁移把第三方插件映射为 `plugin:<包名>`，这里直接用同一形式。
              kind: 'plugin:dsh-memory',
              form: 'snapshot',
              sections: [{ name: 'memory-longterm', text }],
            },
          })
          const messages = decision.messages.slice()
          const firstUser = messages.findIndex((m) => m.role === 'user')
          if (firstUser >= 0) messages.splice(firstUser, 0, memMessage)
          else messages.unshift(memMessage)
          // 走到这里说明消息确实构造好了，此刻才允许消耗这次注入机会。
          // 判定「本次算不算完整」：
          // - loadFailed：读盘出过错，无论注入了什么都不算完整，下轮必须重试。
          // - 否则交给 isCompleteInjection区分「工作区记忆确实为空」与「缺了工作区部分」。
          // 三种结果都不是complete 时保持 partial，让下一轮继续尝试补齐。
          const complete = loadFailed ? false : isCompleteInjection(cwd)
          if (complete) injectedAgents.set(agent, 'complete')
          else if (!injectedAgents.has(agent)) injectedAgents.set(agent, 'partial')
          return { ...decision, messages }
        } catch (e) {
          console.error('[dsh-memory] inject failed, will retry on next step', e && e.message)
          return decision
        }
      }, { prepend: true }), 'dsh-memory: pre-step memory inject')

      // ---- 记忆条目工具（分类维护：按 section 归位，不按日期累加）----
      // 把 content 渲染成一条 bullet（首行带 `- `，续行缩进 2 格）。
      function formatBullet(content) {
        const lines = String(content || '').split('\n')
        const lead = /^\s*[-*]\s+/.test(lines[0]) ? '' : '- '
        return lines.map((ln, i) => {
          const t = (ln || '').trim()
          if (t === '') return ''
          return i === 0 ? lead + t : '  ' + t
        }).join('\n')
      }
      // 找目标分类节：只认标题与 sectionName 完全相等。
      // 早期版本用双向 includes 模糊匹配，短 section 名会劫持长标题节
      // （section='工具' 命中 '## 工具与环境'），再叠加下面的标题覆盖 bug 就会把
      // 记忆文件的节标题悄悄改短。现在匹配不上就另建新节，行为可预期。
      function findSection(blocks, sectionName) {
        for (const b of blocks) {
          if (b.preamble) continue
          const title = b[0].replace(/^##\s*/, '').trim()
          if (title === sectionName) return b
        }
        return null
      }
      // 把一条记忆归入指定分类节：节存在则追加到节内，否则在文件末尾新建 `## <section>`。
      function insertEntry(text, content, section) {
        const sectionName = String(section || '其他').trim()
        const bullet = formatBullet(content)
        const blocks = splitBlocks(text)
        const target = findSection(blocks, sectionName)
        if (target) {
          // 原标题必须在清空数组之前取出。早期版本先 target.length = 0 再读 target[0]，
          // 读到的必然是 undefined，于是 `target[0] || ('## ' + sectionName)` 永远走右边，
          // 每写一条记忆就把原节标题替换成调用方传的 section 名。
          const heading = target[0]
          const body = target.slice(1).filter((ln) => ln.trim() !== '')
          target.length = 0
          target.push(heading)
          target.push(...body)
          target.push(...bullet.split('\n'))
        } else {
          blocks.push(['## ' + sectionName, ...bullet.split('\n')])
        }
        return blocks.map(blockText).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
      }
      // 切块：首个 `## ` 之前的连续行合并成**一个** preamble 块（早期版本一行一个块，
      // 拼接时每行之间都被插入一个空行，导致 memory_read 全量返回时前言区空行膨胀）。
      function splitBlocks(text) {
        const lines = String(text || '').split('\n')
        const blocks = []
        let current = null
        let preamble = null
        for (const line of lines) {
          if (/^##\s/.test(line)) {
            if (preamble) { blocks.push({ preamble }); preamble = null }
            if (current !== null) blocks.push(current)
            current = [line]
          } else if (current !== null) {
            current.push(line)
          } else {
            if (preamble === null) preamble = []
            preamble.push(line)
          }
        }
        if (preamble) blocks.push({ preamble })
        if (current !== null) blocks.push(current)
        return blocks
      }
      function blockText(b) {
        return b.preamble ? b.preamble.join('\n') : b.join('\n')
      }
      // 条目级删除：删掉包含 needle 的 bullet 及其缩进子行，不删整个分类节；残留空节一并清理。
      // 保护：先扫出全部命中条目，命中数 > 1 时**不写文件**，返回歧义清单让调用方收窄关键词。
      // 早期版本直接删所有命中项，传 content='pymssql' 会连带删掉 2 条，是静默数据丢失。
      // 标题判据用 /^#{1,6}\s/ 而非 /^#/：后者会把正文里的 '#1'、'#hashtag' 误判成标题，
      // 从而错误地终止「跳过失行」状态、把本该一起删掉的续行留下。
      function removeEntry(text, needle) {
        const needleLower = String(needle || '').trim().toLowerCase()
        if (!needleLower) return { text, removed: false, hits: [] }
        const lines = String(text || '').split('\n')
        const isHeading = (ln) => /^#{1,6}\s/.test(ln)
        // 第一遍：只数命中，不改内容。
        const hits = []
        for (const line of lines) {
          if (isHeading(line)) continue
          if (/^\s*[-*]\s+/.test(line) && line.toLowerCase().includes(needleLower)) {
            hits.push(line.trim())
          }
        }
        if (hits.length === 0) return { text, removed: false, hits }
        if (hits.length > 1) return { text, removed: false, hits, ambiguous: true }
        // 第二遍：确认只有一条命中，执行删除。
        const out = []
        let removed = false
        let skipping = false
        for (const line of lines) {
          const heading = isHeading(line)
          if (heading) skipping = false
          if (skipping && !heading) {
            if (/^\s/.test(line)) continue
            skipping = false
          }
          if (!skipping && !heading && /^\s*[-*]\s+/.test(line) && line.toLowerCase().includes(needleLower)) {
            removed = true
            skipping = true
            continue
          }
          out.push(line)
        }
        const blocks = splitBlocks(out.join('\n'))
        const kept = blocks.filter((b) => b.preamble || b.slice(1).some((ln) => ln.trim() !== ''))
        const rebuilt = kept.map(blockText).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
        return { text: rebuilt, removed, hits }
      }
      // 空 query 全量返回时同样收敛连续空行，避免前言区被 join('\n\n') 撑开。
      function searchMemory(text, query) {
        const lower = String(query || '').trim().toLowerCase()
        const blocks = splitBlocks(text)
        if (!lower) return blocks.map(blockText).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
        return blocks.filter((b) => blockText(b).toLowerCase().indexOf(lower) >= 0)
          .map(blockText).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
      }
      // 记忆体积指标：条数按 bullet 行计，字数按非空白字符计（中文一字算一字）。
      // 把结果写回模型，是为了让提示词里的「预算」这条纪律**可执行**——模型看不到
      // 文件大小，只能靠这个反馈判断自己该不该现在收。没有这个反馈，预算只是一句空话。
      const MEMORY_BUDGET = { entries: 20, chars: 5000 }
      function memoryStats(text) {
        const lines = String(text || '').split('\n')
        let entries = 0
        for (const ln of lines) if (/^\s*[-*]\s+/.test(ln)) entries++
        const chars = String(text || '').replace(/\s+/g, '').length
        return { entries, chars }
      }
      function budgetNote(next) {
        const st = memoryStats(next)
        const over = []
        if (st.entries > MEMORY_BUDGET.entries) over.push('条数')
        if (st.chars > MEMORY_BUDGET.chars) over.push('字数')
        let note = '（当前 ' + st.entries + ' 条 / ' + st.chars + ' 字）'
        if (over.length) {
          note += '；已超预算（上限 ' + MEMORY_BUDGET.entries + ' 条 / ' + MEMORY_BUDGET.chars
            + ' 字，超出：' + over.join('、') + '），请先合并同主题或删掉已失效条目再继续'
        }
        return note
      }

      const renderText = (args, value) => {
        const msg = value && value.message ? value.message : (value && value.ok ? '已写入记忆' : '写入记忆失败')
        return [{ type: 'text', text: msg }]
      }

      // ---- memory_write：增删条目 ----
      const writeTool = {
        name: 'memory_write',
        description: [
          '维护长期记忆：写给「下一个会话的自己」的经验库，目的是让下次遇到同类问题少走弯路。',
          '它不是工作日志、不是项目文档、不是文件清单。每条记忆在每次新会话都会被全文注入并占用上下文，多写一条就是永久多付一份成本。',
          '',
          '【写之前三问，全过才写】',
          '1. 可复用吗：下个月换个任务还会用到吗？只服务当前这次任务的，不写。',
          '2. 不可推导吗：能从代码、README、git log、目录结构当场看出来的，不写——这些东西会变，记下来反而误导下一个会话。',
          '3. 改变做法吗：它让下次「该怎么做」不同吗？只说明「发生过什么」的，不写。',
          '拿不准就不写。写错比不写更伤：一条错误记忆会让下一个会话按错的来。',
          '',
          '【必须记】',
          '- 踩过的坑：怎么发现的（现象）→ 根因 → 修法或规避。',
          '- 反直觉的约束与决策：为什么不能那样做，以及代价。',
          '- 用户的偏好与禁令：明确说过「不要」「必须」的。',
          '- 外部系统的隐藏行为：静默失效、接口怪癖、看着成功其实没生效。',
          '',
          '【绝对不记】',
          '- 流水账与时间线：「今天做了X」「已修复Y」「9-30 清理了Z」，带日期前缀的条目一律不写。',
          '- 目录树、文件清单、函数名罗列、代码片段、目录体积。',
          '- 一次性的排查过程：只留结论和判据，过程本身不再复述。',
          '- 已完工且不会再碰的任务细节；会话里的临时状态、待办、下一步。',
          '- 现查就能拿到的端口、路径、版本号——除非它正是坑（照着查会错的那种）。',
          '- 「本次改动完成了」这类自我汇报。',
          '',
          '【预算，超了先整理再写】',
          '- 一条 = 一个可独立复用的结论，最多 2 行、120 字。三件事就分三条，别塞一条；也别把一条拆成三行。',
          '- 单节 ≤12 条，整份 ≤20 条 / 5000 字。超预算时先合并同主题、删已失效的，再写新的。',
          '- 同一事实只允许存在一处。发现重复就删掉较弱的那条，不要两条都留。',
          '- 每次写入会返回当前条数与字数，超了会提示；看到提示就当场收敛，不要拖到以后。',
          '- **硬闸门**：add 之后整份超过 20 条 / 5000 字会被直接拒绝，必须先 action=rewrite 整理合并或 action=remove 删减，降到限内才能继续写。',
          '',
          '【渐进式披露：主文件只留高频，低频拆子文件】',
          '- 主记忆文件（agent.md / .agent/memory.md）**只放每次会话都要知道的高频核心**；低频但有价值的细节（外部接口、冷门操作、长命令）不要堆在主文件。',
          '- 超预算整理时，把低频细节拆到同目录子文件 `memory-<主题>.md`（如 memory-external.md / memory-devops.md），主文件里**留一行指针**指向它，需要时按路径读（子文件不进注入，用文件读取工具读，不用 memory_read）。',
          '- 拆完必须同步更新主文件的指针清单，否则下次找不到。',
          '- 已拆出去的主题不再往主文件重复写；主文件只保留指针。',
          '',
          '【add 之前必须做的事】',
          '- 先 memory_read 看现有内容。已有相近条目 → 改写那一条（remove 后 add，或 rewrite 整节），不要新增平行条目。',
          '- 只有确实没有同类条目时才新建。同一主题出现第二条平行条目，就是记错了。',
          '- 判断「相近」按主题不按措辞：同一文件、同一命令、同一接口的都算同一主题。',
          '',
          '【动作语义】',
          '- action=add（默认）：新增或改写一条，content 是要点式 markdown，section 填归入的节名。',
          '- action=remove：content 传关键词，必须唯一命中一条；命中多条会被拒绝并返回清单，收窄后重试。',
          '- action=rewrite：content 传整个文件的新全文，用于重组分类、批量合并、整体瘦身。文件超预算或同主题散落多处时用它可以一次收干净，比逐条 add 省。',
          '- section：必须与已有节标题完全相等（区分「工具与环境」和「工具」），对不上就新建；新建节前先确认它不是已有节的同义词。',
          '- scope：workspace（默认）记当前项目的具体经验；global 只放跨项目通用的事实与用户偏好，项目内的坑不要写 global。',
          '',
          '【节怎么用】',
          '- 常见坑（避坑档案）：主力节。现象→根因→修法，一条一个坑。',
          '- 协作约定：用户偏好、禁令、流程要求。',
          '- 工具与环境：只记「查了会错」的环境事实。',
          '- 项目结构与关键路径：只记非显然的约定和迁移约束（动了会静默坏的那种）。不写目录树、不写文件清单。',
          '- 已解决：只留一句话结论防重复排查，细节删掉。',
          '- 节名以文件里已有的为准，不要新造同义节。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['add', 'remove', 'rewrite'],
              description: 'add=新增/合并一条记忆（默认）；remove=删除包含 content 关键词的条目；rewrite=用 content 全文重写整个记忆文件',
            },
            scope: {
              type: 'string',
              enum: ['global', 'workspace'],
              description: '写入范围：global=全局记忆，workspace=当前工作区记忆（默认）',
            },
            section: {
              type: 'string',
              description: 'add 时归入的分类节名（如“项目结构与关键路径”“常见坑（避坑档案）”“工具与环境”“协作约定”），节不存在会自动创建，缺省归“其他”',
            },
            content: {
              type: 'string',
              description: 'add=要点式 Markdown 条目；remove=要删条目的关键词；rewrite=整个文件的新全文',
            },
          },
          required: ['content'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              scope: { type: 'string' },
              path: { type: 'string' },
              message: { type: 'string' },
            },
          },
          render: renderText,
        },
        async execute(args, exec) {
          const action = args && args.action === 'rewrite' ? 'rewrite' : args && args.action === 'remove' ? 'remove' : 'add'
          const scope = args && args.scope === 'global' ? 'global' : 'workspace'
          const content = String((args && args.content) || '').trim()
          if (!content) return { ok: false, scope, path: '', message: '内容为空' }
          const section = String((args && args.section) || '其他').trim()

          const applyTo = async (pathStr, key, label) => {
            try {
              const current = await readText(pathStr)
              let next
              if (action === 'rewrite') {
                next = content
              } else if (action === 'remove') {
                const res = removeEntry(current, content)
                if (res.ambiguous) {
                  // 命中多条：拒绝写入，把清单回给模型让它收窄关键词再来。
                  return {
                    ok: false,
                    scope,
                    path: pathStr,
                    message: '关键词命中 ' + res.hits.length + ' 条记忆，已拒绝删除（避免误删）。'
                      + '请改用更精确的关键词重新remove。命中条目：\n'
                      + res.hits.map((h, i) => (i + 1) + '. ' + h).join('\n'),
                  }
                }
                if (!res.removed) return { ok: false, scope, path: pathStr, message: '未找到匹配的记忆条目，未删除' }
                next = res.text
              } else {
                next = insertEntry(current, content, section)
                // 硬闸门：写入前先算结果，超限直接拒绝，逼着先整理（rewrite/remove）再写。
                const st = memoryStats(next)
                if (st.entries > MEMORY_BUDGET.entries || st.chars > MEMORY_BUDGET.chars) {
                  return {
                    ok: false,
                    scope,
                    path: pathStr,
                    message: '已达记忆上限（' + MEMORY_BUDGET.entries + ' 条 / ' + MEMORY_BUDGET.chars
                      + ' 字），本次 add 被拒绝（写入后 ' + st.entries + ' 条 / ' + st.chars + ' 字）。'
                      + '请先用 action=rewrite 整理合并全文（合并同主题条目、删除已失效条目），降到限内后再 add。',
                  }
                }
              }
              await writeTextSafe(pathStr, next)
              cache.set(key, { text: next, path: pathStr })
              const verb = action === 'remove' ? '已删除记忆条目' : action === 'rewrite' ? '已重写记忆文件' : '已写入记忆'
              return { ok: true, scope, path: pathStr, message: verb + '：' + label + budgetNote(next) }
            } catch (e) {
              console.error('[dsh-memory] write failed', e && e.message)
              return { ok: false, scope, path: pathStr, message: '写入失败：' + (e && e.message ? e.message : String(e)) }
            }
          }

          if (scope === 'workspace') {
            const cwd = cwdOf(exec && exec.agent)
            if (!cwd) return { ok: false, scope, path: '', message: '无法确定当前工作区' }
            const pathStr = wsPath(cwd)
            return await applyTo(pathStr, wsKey(cwd), pathStr)
          }
          const pathStr = globalPath()
          return await applyTo(pathStr, GLOBAL_KEY, pathStr)
        },
      }

      // ---- memory_read：按需读取/检索 ----
      const readTool = {
        name: 'memory_read',
        description: '按需读取长期记忆（记忆按主题分类节维护）。scope=global 读全局 agent.md，scope=workspace 读当前工作区 .agent/memory.md，不传则两处都读。query 为可选关键词（大小写不敏感），命中返回包含该关键词的整个分类节；不传 query 返回全部内容。',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['global', 'workspace'],
              description: '读取范围（不传则全部）',
            },
            query: {
              type: 'string',
              description: '关键词过滤（可选）',
            },
          },
          required: [],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    scope: { type: 'string' },
                    path: { type: 'string' },
                    content: { type: 'string' },
                  },
                },
              },
              message: { type: 'string' },
            },
          },
          render(args, value) {
            if (!value || !value.ok) return [{ type: 'text', text: (value && value.message) || '读取失败' }]
            const parts = (value.sections || []).map((s) => '【' + s.scope + '】\n' + (s.content || '(空)'))
            const text = parts.length ? parts.join('\n\n') : '未找到匹配的记忆'
            return [{ type: 'text', text }]
          },
        },
        async execute(args, exec) {
          const scope = args && args.scope
          const query = String((args && args.query) || '')
          const sections = []
          try {
            if (scope !== 'workspace') {
              const pathStr = globalPath()
              const text = searchMemory(await readText(pathStr), query)
              sections.push({ scope: 'global', path: pathStr, content: text })
            }
            if (scope !== 'global') {
              const cwd = cwdOf(exec && exec.agent)
              if (cwd) {
                const pathStr = wsPath(cwd)
                const text = searchMemory(await readText(pathStr), query)
                sections.push({ scope: 'workspace', path: pathStr, content: text })
              }
            }
            return { ok: true, sections }
          } catch (e) {
            console.error('[dsh-memory] read failed', e && e.message)
            return { ok: false, sections: [], message: '读取失败：' + (e && e.message ? e.message : String(e)) }
          }
        },
      }

      for (const tool of [writeTool, readTool]) keep(() => tools.register(tool), 'dsh-memory: tools')

      // ---- 设置面板 RPC（POST /dsh-memory/api/<op>）----
      const API_PREFIX = '/dsh-memory/api'
      const apiHandler = async (req, res) => {
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj === undefined ? { ok: true } : obj))
          } catch (e) { /* socket gone */ }
        }
        try {
          if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
          const url = String(req.url || '')
          const q = url.indexOf('?')
          const clean = q >= 0 ? url.slice(0, q) : url
          const rawOp = decodeURIComponent(clean.replace(/^\/+/, '').slice(API_PREFIX.length).replace(/^\/+/, ''))
          const op = rawOp.startsWith('memory-') ? rawOp.slice(7) : rawOp
          const body = await readBody(req)
          if (op === 'read-agent') {
            try {
              const pathStr = globalPath()
              const text = await readText(pathStr)
              return send(200, { path: pathStr, content: text })
            } catch (e) {
              console.error('[dsh-memory] read-agent failed', e && e.message)
              return send(200, { path: globalPath(), content: '' })
            }
          }
          if (op === 'write-agent') {
            try {
              const content = body && typeof body.content === 'string' ? body.content : ''
              const pathStr = globalPath()
              await writeTextSafe(pathStr, content)
              cache.set(GLOBAL_KEY, { text: content, path: pathStr })
              return send(200, { ok: true, path: pathStr })
            } catch (e) {
              console.error('[dsh-memory] write-agent failed', e && e.message)
              return send(200, { ok: false, path: globalPath(), message: e && e.message ? e.message : String(e) })
            }
          }
          return send(404, { error: 'unknown op: ' + op })
        } catch (e) {
          return send(500, { error: String((e && e.message) || e) })
        }
      }
      keep(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }), 'dsh-memory: api routes')
    })
  },
}
