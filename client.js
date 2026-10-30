;(() => {
  // 浏览器半边：只负责画。所有判断都在宿主，这里读一份快照、渲染、上报指针动作。
  // 这个文件是被当作普通脚本加载的，不能 import；宿主只提供 /plugins/<包名>/client.js 一个文件。

  const STYLE_ID = 'dsh-local-pet-style'
  const STYLE = `
.dsh-lp-root{position:fixed;inset:0;z-index:40;pointer-events:none;user-select:none}
.dsh-lp-room{position:absolute;right:18px;bottom:18px;display:flex;align-items:flex-end;gap:10px;pointer-events:none}
.dsh-lp-pet{position:relative;width:96px;height:96px;border-radius:18px;background:rgba(120,160,220,.14);pointer-events:auto;display:flex;align-items:center;justify-content:center}
.dsh-lp-pet[draggable="true"]{cursor:grab}
.dsh-lp-label{position:absolute;left:50%;bottom:-16px;transform:translateX(-50%);font:11px/1.2 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);white-space:nowrap}
.dsh-lp-empty{font:12px/1.4 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);background:rgba(0,0,0,.04);padding:6px 10px;border-radius:10px}
`

  window.__ModuleLoader__.load({
    id: 'dsh-local-pet',
    factory (require) {
      const React = require('react')
      const h = React.createElement

      if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE
        document.head.appendChild(style)
      }

      function useSnapshot () {
        const [snap, setSnap] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          let timer = null
          const pull = async () => {
            try {
              const res = await fetch('/local-pet/state', { cache: 'no-store' })
              if (res.ok && alive) setSnap(await res.json())
            } catch {
              // 宿主还没起来 / 被关掉：下一轮再试
            } finally {
              if (alive) timer = setTimeout(pull, 1000)
            }
          }
          pull()
          return () => {
            alive = false
            if (timer) clearTimeout(timer)
          }
        }, [])
        return snap
      }

      function Room () {
        const snap = useSnapshot()
        if (!snap) return null
        const neighbors = Array.isArray(snap.neighbors) ? snap.neighbors : []
        const guests = Array.isArray(snap.guests) ? snap.guests : []
        const me = snap.self || {}
        return h('div', { className: 'dsh-lp-root' },
          h('div', { className: 'dsh-lp-room' },
            h('div', { className: 'dsh-lp-pet' },
              h('span', { className: 'dsh-lp-label' }, me.nickname || '我')),
            guests.length === 0 && neighbors.length === 0
              ? h('div', { className: 'dsh-lp-empty' }, '局域网里还没有别的宠物')
              : null
          )
        )
      }

      return {
        name: 'local-pet',
        inject: ['slots'],
        apply (ctx) {
          ctx.slots.inject('shell.overlay', function* () {
            yield ctx.slots.register({
              name: 'shell.overlay',
              id: 'local-pet-room',
              order: 900
            }, Room)
          })
        }
      }
    }
  })
})()
