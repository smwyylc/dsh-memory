// dsh-memory — client half (static package)
// 设置面板「记忆」：查看 / 编辑全局 agent.md。
// 静态差异：host.call → 同源 fetch(/dsh-memory/api/<op>)；styles.insert → apply 时注入 <style>。
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')

    // ── Client→Host RPC（静态版：走主机 webServer 的同源 HTTP 路由）──
    function hostCall(op, args) {
      return fetch('/dsh-memory/api/' + encodeURIComponent(op), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args || {}),
      }).then((r) => r.json().then((j) => {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status))
        return j
      }))
    }
    const host = { call: hostCall }

    const MEMORY_CSS = `
      .memory-panel { display: flex; flex-direction: column; gap: 12px; max-width: 760px; padding: 4px 0; }
      .memory-panel__head h3 { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .memory-panel__desc { margin: 0 0 4px; font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
      .memory-panel__path { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .memory-panel__editor {
        width: 100%; min-height: 340px; box-sizing: border-box; resize: vertical;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; line-height: 1.6;
      }
      .memory-panel__editor:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .memory-panel__foot { display: flex; align-items: center; gap: 12px; }
      .memory-panel__save {
        background: var(--dsw-alias-brand-primary); color: #fff; border: none;
        border-radius: 6px; padding: 6px 20px; font-size: 13px; cursor: pointer;
      }
      .memory-panel__save:disabled { opacity: .6; cursor: default; }
      .memory-panel__status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .memory-panel__status--ok { color: var(--dsw-alias-state-success-primary); }
      .memory-panel__status--err { color: var(--dsw-alias-state-error-primary); }
    `

    function MemoryPanel() {
      const [content, setContent] = React.useState('')
      const [path, setPath] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      React.useEffect(() => {
        let alive = true
        host.call('memory-read-agent')
          .then((res) => {
            if (!alive) return
            if (res && typeof res.content === 'string') setContent(res.content)
            if (res && typeof res.path === 'string') setPath(res.path)
            setLoading(false)
          })
          .catch((e) => {
            if (!alive) return
            setStatus({ kind: 'err', text: '读取失败：' + (e && e.message ? e.message : String(e)) })
            setLoading(false)
          })
        return () => { alive = false }
      }, [])

      const onSave = () => {
        setStatus({ kind: 'info', text: '保存中…' })
        host.call('memory-write-agent', { content })
          .then((res) => {
            setStatus(res && res.ok ? { kind: 'ok', text: '已保存' } : { kind: 'err', text: '保存失败' })
          })
          .catch((e) => {
            setStatus({ kind: 'err', text: '保存失败：' + (e && e.message ? e.message : String(e)) })
          })
      }

      return React.createElement('div', { className: 'memory-panel' },
        React.createElement('div', { className: 'memory-panel__head' },
          React.createElement('h3', null, 'Agent 人格信息（agent.md）'),
          React.createElement('p', { className: 'memory-panel__desc' }, '这份内容会作为我的“人格 / 长期记忆”，在每个会话开始时注入一次快照（不再写入系统提示词，写记忆不会反复加载）。会话中需要最新记忆时我会按需读取。可直接在这里查看、编辑、保存。'),
          React.createElement('p', { className: 'memory-panel__path' }, path || (loading ? '读取中…' : ''))
        ),
        React.createElement('textarea', {
          className: 'memory-panel__editor',
          value: content,
          onChange: (e) => setContent(e.target.value),
          placeholder: '# Agent 人格信息\n\n在这里编写想让我长期记住的内容（要点式 Markdown）…',
          spellCheck: false,
        }),
        React.createElement('div', { className: 'memory-panel__foot' },
          React.createElement('button', { className: 'memory-panel__save', onClick: onSave, disabled: loading }, '保存'),
          status ? React.createElement('span', {
            className: 'memory-panel__status' + (status.kind === 'ok' ? ' memory-panel__status--ok' : status.kind === 'err' ? ' memory-panel__status--err' : ''),
          }, status.text) : null
        )
      )
    }

    const apply = (ctx) => {
      ctx.effect(() => {
        if (typeof document === 'undefined') return
        let tag = document.getElementById('dsh-memory-styles')
        if (!tag) {
          tag = document.createElement('style')
          tag.id = 'dsh-memory-styles'
          document.head.appendChild(tag)
        }
        tag.textContent = MEMORY_CSS
      }, 'dsh-memory: styles')

      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'memory', order: 25, label: '记忆' },
        () => React.createElement(MemoryPanel, null),
      ))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
