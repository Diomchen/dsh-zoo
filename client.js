;(() => {
  // 浏览器半边：只负责画。所有判断都在宿主，这里读一份快照、渲染、上报改名动作。
  // 这个文件是被当作普通脚本加载的，不能 import；宿主只提供 /plugins/<包名>/client.js 一个文件。

  const STYLE_ID = 'dsh-local-pet-style'
  const STATE_URL = '/local-pet/state'
  const ACTION_URL = '/local-pet/action'
  const THUMB_PREFIX = '/dsh-pet-7340/thumb/main/'
  const IDLE_CLIPS = ['东张西望', '原地漂浮踏步', '原地小憩沉眠']
  const IDLE_ROTATE_MS = 4500
  const NEIGHBOR_TTL_MS = 30000
  const NEIGHBOR_FADE_MS = 6000
  const MAX_LIGHTS = 6

  const STYLE = `
.dsh-lp-root{position:fixed;inset:0;z-index:40;pointer-events:none;user-select:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-lp-room{position:absolute;right:18px;bottom:18px;display:flex;align-items:flex-end;gap:12px;pointer-events:none}
.dsh-lp-pet{position:relative;width:96px;height:96px;border-radius:18px;background:rgba(120,160,220,.14);pointer-events:auto;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.dsh-lp-pet[draggable="true"]{cursor:grab}
.dsh-lp-media{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;color:var(--dsw-alias-text-secondary,#8899aa)}
.dsh-lp-name{position:absolute;left:50%;bottom:-17px;transform:translateX(-50%);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.2 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);pointer-events:auto;cursor:default}
.dsh-lp-note{max-width:260px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.06);font:12px/1.45 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);pointer-events:none}
.dsh-lp-lights{position:absolute;right:18px;bottom:146px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:min(48vw,420px);pointer-events:none}
.dsh-lp-light{display:flex;align-items:center;gap:6px;max-width:132px;padding:4px 8px;border-radius:999px;background:rgba(20,26,34,.58);color:#eaf1fb;font:11px/1.2 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);pointer-events:none;transition:opacity .8s linear}
.dsh-lp-light-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-lp-dot{width:6px;height:6px;border-radius:50%;background:#7ee0a3;box-shadow:0 0 6px #7ee0a3;flex:0 0 auto}
.dsh-lp-light-more{padding:4px 6px;background:transparent;box-shadow:none;color:var(--dsw-alias-text-secondary,#8899aa)}
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
              const res = await fetch(STATE_URL, { cache: 'no-store' })
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

      function useNow (intervalMs) {
        const [now, setNow] = React.useState(() => Date.now())
        React.useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), intervalMs)
          return () => clearInterval(timer)
        }, [intervalMs])
        return now
      }

      function safeText (value, max) {
        if (typeof value !== 'string') return ''
        const clean = value
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (clean === '') return ''
        const chars = Array.from(clean)
        return chars.length > max ? chars.slice(0, max).join('') : clean
      }

      function thumbUrl (name) {
        try {
          return THUMB_PREFIX + encodeURIComponent(name) + '.webm'
        } catch {
          // 孤立代理项等非法字符串不能把 render 弄崩
          return null
        }
      }

      function PetBlob ({ label }) {
        const short = safeText(label, 10) || '宠物'
        return h('svg', {
          className: 'dsh-lp-media',
          viewBox: '0 0 96 96',
          role: 'img',
          'aria-label': label
        },
        h('ellipse', { cx: 48, cy: 54, rx: 33, ry: 29, fill: 'rgba(122,162,232,.88)' }),
        h('circle', { cx: 36, cy: 48, r: 4, fill: 'rgba(20,26,34,.8)' }),
        h('circle', { cx: 60, cy: 48, r: 4, fill: 'rgba(20,26,34,.8)' }),
        h('path', {
          d: 'M38 62 Q48 69 58 62',
          fill: 'none',
          stroke: 'rgba(20,26,34,.6)',
          strokeWidth: 2,
          strokeLinecap: 'round'
        }),
        h('text', {
          x: 48,
          y: 87,
          textAnchor: 'middle',
          fontSize: 9,
          fill: 'currentColor'
        }, short))
      }

      function PetMedia ({ pet, label }) {
        const anim = pet && typeof pet.anim === 'string' ? pet.anim : null
        const [idleIndex, setIdleIndex] = React.useState(0)
        const [broken, setBroken] = React.useState(false)

        React.useEffect(() => {
          setBroken(false)
        }, [anim])

        React.useEffect(() => {
          // 没有“被点播过”的动作时，轮播几段真实存在的待机素材。
          if (anim || broken) return undefined
          const timer = setInterval(() => setIdleIndex((index) => index + 1), IDLE_ROTATE_MS)
          return () => clearInterval(timer)
        }, [anim, broken])

        if (broken) return h(PetBlob, { label })

        const clip = anim || IDLE_CLIPS[idleIndex % IDLE_CLIPS.length]
        const src = thumbUrl(clip)
        if (src === null) return h(PetBlob, { label })
        return h('video', {
          key: src,
          className: 'dsh-lp-media',
          src,
          autoPlay: true,
          loop: true,
          muted: true,
          playsInline: true,
          preload: 'auto',
          'aria-label': label,
          title: label,
          onError: () => setBroken(true)
        })
      }

      function bridgeText (reason, hasPet) {
        if (reason === 'starting') return '正在找 dsh-pet…'
        if (reason === 'not-installed') {
          return hasPet
            ? '没找到 dsh-pet：先显示名字占位，邻居灯仍然可用。'
            : '没找到 dsh-pet：客厅里暂时没有宠物，邻居灯仍然可用。'
        }
        if (reason === 'unreachable') {
          return hasPet
            ? 'dsh-pet 没有响应：先显示待机影子。'
            : 'dsh-pet 没有响应：客厅先显示这一行说明。'
        }
        if (reason === 'no-pet') return 'dsh-pet 里还没有宠物。'
        if (reason === 'error') return 'dsh-pet 桥接出错：客厅先显示这一行说明。'
        return '暂时看不到本地宠物（dsh-pet 未就绪）。'
      }

      function Note ({ pet, bridge }) {
        if (pet !== null && (bridge === null || bridge.ok !== false)) return null
        return h('div', { className: 'dsh-lp-note', role: 'status' }, bridgeText(bridge?.reason, pet !== null))
      }

      function LightStrip ({ neighbors, now }) {
        const visible = []
        for (const neighbor of neighbors) {
          if (neighbor === null || typeof neighbor !== 'object') continue
          const deviceId = safeText(neighbor.deviceId, 64)
          if (deviceId === '') continue
          const nickname = safeText(neighbor.nickname, 32) || '邻居'
          const lastSeen = Number(neighbor.lastSeen)
          const age = Number.isFinite(lastSeen) ? now - lastSeen : NEIGHBOR_TTL_MS
          if (age >= NEIGHBOR_TTL_MS) continue
          const opacity = age <= NEIGHBOR_TTL_MS - NEIGHBOR_FADE_MS
            ? 1
            : Math.max(0, (NEIGHBOR_TTL_MS - age) / NEIGHBOR_FADE_MS)
          if (opacity <= 0.02) continue
          visible.push({ deviceId, nickname, opacity })
        }
        if (visible.length === 0) return null

        const shown = visible.slice(0, MAX_LIGHTS)
        const extra = visible.length - shown.length
        return h('div', { className: 'dsh-lp-lights', 'aria-label': '邻居' },
          shown.map((neighbor) => h('div', {
            key: neighbor.deviceId,
            className: 'dsh-lp-light',
            style: { opacity: neighbor.opacity },
            title: neighbor.nickname
          },
          h('span', { className: 'dsh-lp-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsh-lp-light-name' }, neighbor.nickname))),
          extra > 0
            ? h('div', { key: 'more', className: 'dsh-lp-light dsh-lp-light-more', title: '还有 ' + extra + ' 位邻居' }, '+' + extra)
            : null)
      }

      function Room () {
        const snap = useSnapshot()
        const now = useNow(1000)
        if (!snap) return null

        const self = snap.self !== null && typeof snap.self === 'object' ? snap.self : {}
        const pet = self.pet !== null && typeof self.pet === 'object' ? self.pet : null
        const bridge = self.bridge !== null && typeof self.bridge === 'object' ? self.bridge : null
        const nickname = safeText(self.nickname, 32) || '我'
        const label = (pet !== null ? safeText(pet.name, 64) : '') || nickname
        const neighbors = Array.isArray(snap.neighbors) ? snap.neighbors : []

        const rename = async () => {
          if (typeof window === 'undefined' || typeof window.prompt !== 'function') return
          let input
          try {
            input = window.prompt('邻居看到的名字（最多 32 个字符）', nickname)
          } catch {
            return
          }
          if (input === null || typeof input !== 'string') return
          const next = safeText(input, 32)
          if (next === '' || next === nickname) return
          try {
            await fetch(ACTION_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'rename', nickname: next })
            })
          } catch {
            // 下一轮快照会告诉我们改名没成功；这里不弹错误层
          }
        }

        return h('div', { className: 'dsh-lp-root' },
          h(LightStrip, { neighbors, now }),
          h('div', { className: 'dsh-lp-room' },
            pet !== null
              ? h('div', { className: 'dsh-lp-pet', 'data-testid': 'local-pet' },
                h(PetMedia, { pet, label }),
                h('span', {
                  className: 'dsh-lp-name',
                  title: '双击改昵称 · 邻居看到：' + nickname,
                  onDoubleClick: (event) => {
                    event?.stopPropagation?.()
                    rename()
                  }
                }, label))
              : null,
            h(Note, { pet, bridge })))
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
