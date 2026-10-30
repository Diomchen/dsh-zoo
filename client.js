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
  // 同屏最多四位访客；多出来的折进灯条的 +N，不往主界面上铺。
  const MAX_GUESTS_ON_SCREEN = 4

  const STYLE = `
.dsh-lp-root{position:fixed;inset:0;z-index:40;pointer-events:none;user-select:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-lp-room{position:absolute;right:18px;bottom:18px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:flex-end;gap:12px;max-width:min(calc(100vw - 36px),640px);pointer-events:none}
.dsh-lp-pet{position:relative;width:96px;height:96px;border-radius:18px;background:rgba(120,160,220,.14);pointer-events:auto;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.dsh-lp-pet[draggable="true"]{cursor:grab}
.dsh-lp-media{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;color:var(--dsw-alias-text-secondary,#8899aa)}
.dsh-lp-name{position:absolute;left:50%;bottom:-17px;transform:translateX(-50%);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.2 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);pointer-events:auto;cursor:default}
.dsh-lp-guest{width:84px;height:84px;border-radius:16px;background:rgba(150,190,240,.11)}
.dsh-lp-name-guest{max-width:96px;pointer-events:none}
.dsh-lp-note{max-width:260px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.06);font:12px/1.45 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);pointer-events:none}
.dsh-lp-prompt{position:absolute;right:150px;bottom:22px;width:min(220px,calc(100vw - 180px));box-sizing:border-box;padding:10px 12px;border-radius:14px;background:rgba(20,26,34,.86);color:#eaf1fb;box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:auto;font:12px/1.4 system-ui,sans-serif}
.dsh-lp-prompt-title{display:flex;flex-wrap:wrap;gap:4px;margin:0 20px 8px 0;overflow-wrap:anywhere}
.dsh-lp-prompt-name{font-weight:600;color:#fff}
.dsh-lp-prompt-actions{display:flex;gap:8px}
.dsh-lp-prompt-btn{flex:1 1 auto;padding:6px 8px;border:0;border-radius:9px;background:rgba(255,255,255,.14);color:#eaf1fb;font:12px/1.2 system-ui,sans-serif;cursor:pointer}
.dsh-lp-prompt-btn[data-kind="accept"]{background:#3b74d8;color:#fff}
.dsh-lp-prompt-btn:disabled{opacity:.55;cursor:default}
.dsh-lp-prompt-close{position:absolute;top:4px;right:6px;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:rgba(234,241,251,.7);font:14px/20px system-ui,sans-serif;cursor:pointer}
.dsh-lp-prompt-close:hover{background:rgba(255,255,255,.12);color:#fff}
.dsh-lp-prompt-error{margin-top:6px;color:#ffb4a8;font-size:11px}
.dsh-lp-lights{position:absolute;right:18px;bottom:146px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:min(48vw,420px);pointer-events:none}
.dsh-lp-light{display:flex;align-items:center;gap:6px;max-width:132px;padding:4px 8px;border-radius:999px;background:rgba(20,26,34,.58);color:#eaf1fb;font:11px/1.2 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);pointer-events:none;transition:opacity .8s linear}
.dsh-lp-light-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-lp-dot{width:6px;height:6px;border-radius:50%;background:#7ee0a3;box-shadow:0 0 6px #7ee0a3;flex:0 0 auto}
.dsh-lp-light-more{padding:4px 6px;background:transparent;box-shadow:none;color:var(--dsw-alias-text-secondary,#8899aa)}
@media (max-width:760px){.dsh-lp-pet{width:72px;height:72px}.dsh-lp-guest{width:64px;height:64px}.dsh-lp-name{max-width:96px;font-size:10px}}
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

      function readPrompt (value) {
        if (value === null || typeof value !== 'object') return null
        const deviceId = safeText(value.deviceId, 64)
        if (deviceId === '') return null
        return { deviceId, nickname: safeText(value.nickname, 32) || '邻居' }
      }

      // 动画名会被拼进 URL：和宿主一样只接受普通名字，坏名字退到待机/色块。
      function safeAnimName (value) {
        if (typeof value !== 'string') return null
        const name = value.trim()
        if (name === '' || name.length > 64 || name === '.' || name === '..') return null
        if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null
        return name
      }

      // 快照是宿主的契约，但渲染层仍然只读自己认识的字段；重复 deviceId 只画一次。
      function readGuests (value) {
        if (!Array.isArray(value)) return []
        const guests = []
        const seen = new Set()
        for (const item of value) {
          if (item === null || typeof item !== 'object') continue
          const deviceId = safeText(item.deviceId, 64)
          if (deviceId === '' || seen.has(deviceId)) continue
          seen.add(deviceId)
          guests.push({
            deviceId,
            nickname: safeText(item.nickname, 32) || '邻居',
            anim: safeAnimName(item.anim)
          })
        }
        return guests
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
        const anim = pet ? safeAnimName(pet.anim) : null
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

      /**
       * 访客：和本地宠物共用同一套素材路由，但它是本机自己画的影子。
       * 没有动作名时轮播 idle；动作名不认识/视频 404 时退到带昵称的色块。
       */
      function GuestPet ({ guest }) {
        return h('div', {
          className: 'dsh-lp-pet dsh-lp-guest',
          'data-testid': 'guest-pet',
          'data-device-id': guest.deviceId,
          title: guest.nickname
        },
        h(PetMedia, { pet: { name: guest.nickname, anim: guest.anim }, label: guest.nickname }),
        h('span', { className: 'dsh-lp-name dsh-lp-name-guest', title: guest.nickname }, guest.nickname))
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

      function LightStrip ({ neighbors, now, extraGuests = 0 }) {
        const visible = []
        for (const neighbor of neighbors) {
          if (neighbor === null || typeof neighbor !== 'object') continue
          // 拒绝过的邻居不再出现在客厅里（包括灯）；放行之前仍然要看得见。
          if (neighbor.status === 'denied') continue
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
        // 客厅里最多四位访客，其余折进这里的 +N；没有灯只有多余访客时也要显示。
        if (visible.length === 0 && extraGuests === 0) return null

        const shown = visible.slice(0, MAX_LIGHTS)
        const extra = visible.length - shown.length + Math.max(0, extraGuests)
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

      function PromptCard ({ prompt }) {
        const [busy, setBusy] = React.useState(false)
        const [hidden, setHidden] = React.useState(false)
        const [failed, setFailed] = React.useState(false)

        if (prompt === null || hidden) return null

        const post = (action) => fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, deviceId: prompt.deviceId })
        })

        const decide = async (action) => {
          if (busy) return
          setBusy(true)
          setFailed(false)
          try {
            const res = await post(action)
            if (!res.ok) throw new Error('refused')
            setHidden(true)
          } catch {
            setFailed(true)
          } finally {
            setBusy(false)
          }
        }

        const dismiss = () => {
          setHidden(true)
          try {
            post('dismiss')
              .then((res) => {
                // 宿主没接住（例如这一位刚好消失）就把卡片放回来，别假装已经收起。
                if (!res.ok) setHidden(false)
              })
              .catch(() => setHidden(false))
          } catch {
            // fetch 不可用：本机先收起，不改任何信任状态
          }
        }

        return h('div', {
          className: 'dsh-lp-prompt',
          role: 'dialog',
          'aria-label': '放行邻居'
        },
        h('button', {
          type: 'button',
          className: 'dsh-lp-prompt-close',
          title: '稍后再说',
          'aria-label': '稍后再说',
          disabled: busy,
          onClick: dismiss
        }, '×'),
        h('div', { className: 'dsh-lp-prompt-title' },
          h('span', { className: 'dsh-lp-prompt-name' }, prompt.nickname),
          h('span', null, '想进来看看')),
        h('div', { className: 'dsh-lp-prompt-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-lp-prompt-btn',
            'data-kind': 'accept',
            disabled: busy,
            onClick: () => decide('admit')
          }, '接受'),
          h('button', {
            type: 'button',
            className: 'dsh-lp-prompt-btn',
            'data-kind': 'reject',
            disabled: busy,
            onClick: () => decide('reject')
          }, '拒绝')),
        failed
          ? h('div', { className: 'dsh-lp-prompt-error', role: 'status' }, '没成功，再试一次')
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
        const guests = readGuests(snap.guests)
        // 同屏最多四位；剩下的只计数，交给灯条的 +N。
        const shownGuests = guests.slice(0, MAX_GUESTS_ON_SCREEN)
        const extraGuests = guests.length - shownGuests.length
        const prompt = readPrompt(snap.prompt)

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
          h(LightStrip, { neighbors, now, extraGuests }),
          prompt !== null ? h(PromptCard, { key: prompt.deviceId, prompt }) : null,
          h('div', { className: 'dsh-lp-room' },
            shownGuests.map((guest) => h(GuestPet, { key: guest.deviceId, guest })),
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
