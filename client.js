;(() => {
  // 浏览器半边：只负责画。判断尽量留在宿主的快照里；视图自己的逻辑
  //（素材 404 降级、访客淡出、弹层开合）只能写在这里，见 SPEC 的 Testing Decisions。
  // 这个文件是被当作普通脚本加载的，不能 import；宿主只提供 /plugins/<包名>/client.js 一个文件。

  const STYLE_ID = 'dsh-local-pet-style'
  const STATE_URL = '/local-pet/state'
  const ACTION_URL = '/local-pet/action'
  const THUMB_PREFIX = '/dsh-pet-7340/thumb/main/'
  const IDLE_CLIPS = ['东张西望', '原地漂浮踏步', '原地小憩沉眠']
  const IDLE_ROTATE_MS = 4500
  const NEIGHBOR_TTL_MS = 30000
  const NEIGHBOR_FADE_MS = 6000
  // 心跳影子到期前最后 2.5 秒淡出；Host 仍然在 30 秒 TTL 到点时移除。
  const GUEST_FADE_MS = 2500
  const MAX_LIGHTS = 6
  // 同屏最多四位访客；多出来的折进灯条的 +N，不往主界面上铺。
  const MAX_GUESTS_ON_SCREEN = 4
  const MAX_VISIT_RECORDS = 5
  // 宿主保留最近 3 条提示；客户端只显示最近 20 秒内的，避免旧失败一直挂着。
  const NOTICE_TTL_MS = 20000

  const STYLE = `
.dsh-lp-root{position:fixed;inset:0;z-index:40;pointer-events:none;user-select:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-lp-room{position:absolute;right:18px;bottom:18px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:flex-end;gap:12px;max-width:min(calc(100vw - 36px),640px);pointer-events:none}
.dsh-lp-pet{position:relative;width:96px;height:96px;border-radius:18px;background:rgba(120,160,220,.14);pointer-events:auto;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.dsh-lp-pet[draggable="true"]{cursor:grab}
.dsh-lp-pet[draggable="true"]:active{cursor:grabbing}
.dsh-lp-pet-out{background:rgba(120,160,220,.07);border:1px dashed rgba(136,153,170,.5);flex-direction:column;gap:2px;cursor:pointer}
.dsh-lp-out-text{font:600 13px/1.3 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa)}
.dsh-lp-media{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;color:var(--dsw-alias-text-secondary,#8899aa)}
.dsh-lp-name{position:absolute;left:50%;bottom:-17px;transform:translateX(-50%);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.2 system-ui,sans-serif;color:var(--dsw-alias-text-secondary,#8899aa);pointer-events:auto;cursor:default}
.dsh-lp-guest{width:84px;height:84px;border-radius:16px;background:rgba(150,190,240,.11);transition:opacity .9s linear}
.dsh-lp-guest-visiting{background:rgba(126,224,163,.13);box-shadow:0 0 0 1px rgba(126,224,163,.28);cursor:pointer}
.dsh-lp-name-guest{max-width:96px;pointer-events:none}
.dsh-lp-visitor-badge{position:absolute;top:-6px;right:-4px;padding:1px 5px;border-radius:999px;background:#2f8f5b;color:#fff;font:9px/1.4 system-ui,sans-serif;pointer-events:none}
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
.dsh-lp-light{display:flex;align-items:center;gap:6px;max-width:132px;padding:4px 8px;border-radius:999px;background:rgba(20,26,34,.58);color:#eaf1fb;font:11px/1.2 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);pointer-events:auto;cursor:pointer;transition:opacity .8s linear,box-shadow .15s ease}
.dsh-lp-light-drop{box-shadow:0 0 0 2px #7ee0a3,0 2px 8px rgba(0,0,0,.18);background:rgba(20,60,40,.82)}
.dsh-lp-light-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-lp-dot{width:6px;height:6px;border-radius:50%;background:#7ee0a3;box-shadow:0 0 6px #7ee0a3;flex:0 0 auto}
.dsh-lp-light-more{padding:4px 6px;background:transparent;box-shadow:none;color:var(--dsw-alias-text-secondary,#8899aa);pointer-events:none;cursor:default}
.dsh-lp-door{padding:3px 8px;border:1px solid rgba(136,153,170,.35);border-radius:999px;background:rgba(20,26,34,.5);color:#cfdae8;font:10px/1.4 system-ui,sans-serif;cursor:pointer;pointer-events:auto;transition:background .15s ease,color .15s ease}
.dsh-lp-door[data-on="false"]{background:rgba(120,40,40,.58);border-color:rgba(255,140,120,.5);color:#ffd9d0}
.dsh-lp-door:disabled{opacity:.55;cursor:default}
.dsh-lp-pop{position:absolute;right:18px;bottom:196px;width:min(200px,calc(100vw - 36px));box-sizing:border-box;padding:10px 12px;border-radius:14px;background:rgba(20,26,34,.9);color:#eaf1fb;box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:auto;font:12px/1.4 system-ui,sans-serif}
.dsh-lp-pop-name{font-weight:600;color:#fff;overflow-wrap:anywhere}
.dsh-lp-pop-sub{margin:4px 0 0;color:rgba(234,241,251,.7);font-size:11px;overflow-wrap:anywhere}
.dsh-lp-notices{position:absolute;left:18px;bottom:18px;display:flex;flex-direction:column;gap:6px;max-width:min(320px,calc(100vw - 150px));pointer-events:none}
.dsh-lp-notice{padding:7px 10px;border-radius:10px;background:rgba(20,26,34,.82);color:#f2f6fc;font:12px/1.45 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.2);overflow-wrap:anywhere}
.dsh-lp-card{position:absolute;right:18px;bottom:200px;width:min(250px,calc(100vw - 36px));max-height:min(42vh,320px);overflow:auto;box-sizing:border-box;padding:10px 12px;border-radius:14px;background:rgba(20,26,34,.9);color:#eaf1fb;box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:auto;font:12px/1.4 system-ui,sans-serif}
.dsh-lp-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 20px 2px 0;font-weight:600;color:#fff}
.dsh-lp-card-sub{margin:0 0 8px;color:rgba(234,241,251,.7);font-size:11px;overflow-wrap:anywhere}
.dsh-lp-card-close{position:absolute;top:6px;right:6px;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:rgba(234,241,251,.7);font:14px/20px system-ui,sans-serif;cursor:pointer}
.dsh-lp-card-close:hover{background:rgba(255,255,255,.12);color:#fff}
.dsh-lp-card-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.dsh-lp-card-row{display:grid;grid-template-columns:auto 1fr auto;align-items:baseline;gap:7px;padding:4px 0;border-top:1px solid rgba(255,255,255,.08)}
.dsh-lp-card-dir{font-size:10px;padding:1px 5px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff}
.dsh-lp-card-dir[data-dir="out"]{background:#2f5fa8}
.dsh-lp-card-dir[data-dir="in"]{background:#2f8f5b}
.dsh-lp-card-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-lp-card-meta{color:rgba(234,241,251,.62);font-size:10px;white-space:nowrap}
.dsh-lp-card-empty{margin:6px 0;color:rgba(234,241,251,.62)}
.dsh-lp-card-actions{display:flex;gap:8px;margin-top:9px}
.dsh-lp-card-btn{flex:1 1 auto;padding:6px 8px;border:0;border-radius:9px;background:rgba(255,255,255,.14);color:#eaf1fb;font:12px/1.2 system-ui,sans-serif;cursor:pointer}
.dsh-lp-card-btn[data-kind="recall"]{background:#a8542f}
.dsh-lp-card-btn:disabled{opacity:.55;cursor:default}
.dsh-lp-card-error{margin-top:6px;color:#ffb4a8;font-size:11px}
@media (max-width:760px){.dsh-lp-pet{width:72px;height:72px}.dsh-lp-guest{width:64px;height:64px}.dsh-lp-name{max-width:96px;font-size:10px}.dsh-lp-card{bottom:170px;width:min(230px,calc(100vw - 36px))}}
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
          const expiresAt = Number(item.expiresAt)
          guests.push({
            deviceId,
            nickname: safeText(item.nickname, 32) || '邻居',
            anim: safeAnimName(item.anim),
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
          })
        }
        return guests
      }

      // 本地宠物出门的状态。host 已经校验过；渲染层仍然只接受自己画得出来的形状。
      function readOut (value) {
        if (value === null || typeof value !== 'object') return null
        const deviceId = safeText(value.deviceId, 64)
        const visitId = safeText(value.visitId, 64)
        const phase = value.phase === 'active'
          ? 'active'
          : value.phase === 'requesting' ? 'requesting' : null
        const startedAt = Number(value.startedAt)
        const endsAt = value.endsAt === null ? null : Number(value.endsAt)
        if (deviceId === '' || visitId === '' || phase === null) return null
        if (!Number.isFinite(startedAt)) return null
        if (phase === 'active' && !Number.isFinite(endsAt)) return null
        return {
          deviceId,
          nickname: safeText(value.nickname, 32) || '邻居',
          visitId,
          phase,
          startedAt,
          endsAt
        }
      }

      // 60 秒串门访客：和心跳影子分开读，客户端优先把它画成“来访”。
      function readVisitors (value) {
        if (!Array.isArray(value)) return []
        const visitors = []
        const seen = new Set()
        for (const item of value) {
          if (item === null || typeof item !== 'object') continue
          const deviceId = safeText(item.deviceId, 64)
          if (deviceId === '' || seen.has(deviceId)) continue
          const visitId = safeText(item.visitId, 64)
          const since = Number(item.since)
          const endsAt = Number(item.endsAt)
          if (visitId === '' || !Number.isFinite(since) || !Number.isFinite(endsAt)) continue
          seen.add(deviceId)
          visitors.push({
            deviceId,
            nickname: safeText(item.nickname, 32) || '邻居',
            anim: safeAnimName(item.anim),
            visitId,
            since,
            endsAt
          })
        }
        return visitors
      }

      // 最近五条记录，最新的在前。宿主最多给 5 条，这里再兜一层。
      function readVisits (value) {
        if (!Array.isArray(value)) return []
        const visits = []
        for (const item of value) {
          if (item === null || typeof item !== 'object') continue
          if (item.direction !== 'out' && item.direction !== 'in') continue
          const nickname = safeText(item.nickname, 32) || '邻居'
          const startedAt = Number(item.startedAt)
          const durationMs = Number(item.durationMs)
          if (!Number.isFinite(startedAt) || !Number.isFinite(durationMs)) continue
          if (durationMs < 0) continue
          visits.push({ direction: item.direction, nickname, startedAt, durationMs })
        }
        visits.sort((left, right) => right.startedAt - left.startedAt)
        return visits.slice(0, MAX_VISIT_RECORDS)
      }

      function readNotices (value) {
        if (!Array.isArray(value)) return []
        const notices = []
        for (const item of value) {
          if (item === null || typeof item !== 'object') continue
          const text = safeText(item.text, 256)
          const at = Number(item.at)
          if (text === '' || !Number.isFinite(at)) continue
          notices.push({ text, at })
        }
        return notices.slice(0, 3)
      }

      function formatDuration (ms) {
        const value = Math.max(0, Number(ms) || 0)
        if (value < 1000) return '不到 1 秒'
        if (value < 60000) return Math.round(value / 1000) + ' 秒'
        return Math.max(1, Math.round(value / 60000)) + ' 分钟'
      }

      function formatClock (at) {
        try {
          return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        } catch {
          return ''
        }
      }

      function PetBlob ({ label }) {
        const short = safeText(label, 10) || '宠物'
        return h('svg', {
          className: 'dsh-lp-media',
          viewBox: '0 0 96 96',
          role: 'img',
          draggable: false,
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

      /**
       * 素材降级链（本地宠物、访客、邻居访客共用）：
       *   已知动作 → 那段素材；它 404/坏了 → 一段待机素材；待机也取不到 → 带名字的色块。
       * 只认第一段 404 就画色块会让一个缺失的动作跳过本来可用的待机素材。
       */
      function PetMedia ({ pet, label }) {
        const anim = pet ? safeAnimName(pet.anim) : null
        const [idleIndex, setIdleIndex] = React.useState(0)
        const [idleFailures, setIdleFailures] = React.useState(0)
        const [animFailed, setAnimFailed] = React.useState(false)
        const [blob, setBlob] = React.useState(false)

        React.useEffect(() => {
          // 动作一变就从头再试：404 只属于刚才那一段素材。
          setAnimFailed(false)
          setIdleIndex(0)
          setIdleFailures(0)
          setBlob(false)
        }, [anim])

        React.useEffect(() => {
          // 没有“被点播过”的动作时，轮播几段真实存在的待机素材。
          // 已经在降级路径上时不再轮播，专心把剩下的待机素材试完。
          if (anim || blob || animFailed || idleFailures > 0) return undefined
          const timer = setInterval(() => setIdleIndex((index) => index + 1), IDLE_ROTATE_MS)
          return () => clearInterval(timer)
        }, [anim, animFailed, blob, idleFailures])

        if (blob) return h(PetBlob, { label })

        const usingAnim = anim !== null && !animFailed
        const clip = usingAnim ? anim : IDLE_CLIPS[idleIndex % IDLE_CLIPS.length]
        const src = thumbUrl(clip)
        if (src === null) return h(PetBlob, { label })
        return h('video', {
          // 同一段素材也要能重新挂载（例如动作名恰好等于待机片段）：key 带降级阶段。
          key: src + ':' + (usingAnim ? 'anim' : 'idle-' + idleIndex + '-' + idleFailures),
          className: 'dsh-lp-media',
          src,
          autoPlay: true,
          loop: true,
          muted: true,
          playsInline: true,
          preload: 'auto',
          draggable: false,
          'aria-label': label,
          title: label,
          onError: () => {
            if (usingAnim) {
              setAnimFailed(true)
              setIdleIndex(0)
              setIdleFailures(0)
              return
            }
            // 待机素材最多试 IDLE_CLIPS.length 段；全都取不到才画色块。
            const next = idleFailures + 1
            if (next >= IDLE_CLIPS.length) {
              setBlob(true)
              return
            }
            setIdleIndex(idleIndex + 1)
            setIdleFailures(next)
          }
        })
      }

      /**
       * 访客：和本地宠物共用同一套素材路由，但它是本机自己画的影子。
       * 没有动作名时轮播 idle；动作名不认识/视频 404 时先退到 idle，仍取不到才画带昵称的色块。
       * visiting=true 表示这是 60 秒串门访客（可点开串门卡片）；否则是心跳影子。
       * 心跳影子带宿主给的 expiresAt，最后 2.5 秒在本机淡出。
       */
      function GuestPet ({ guest, visiting = false, onClick, now }) {
        const interactive = typeof onClick === 'function'
        const remaining = Number.isFinite(guest.expiresAt) ? guest.expiresAt - now : Infinity
        const opacity = visiting ? 1 : Math.max(0, Math.min(1, remaining / GUEST_FADE_MS))
        return h('div', {
          className: 'dsh-lp-pet dsh-lp-guest' + (visiting ? ' dsh-lp-guest-visiting' : ''),
          'data-testid': visiting ? 'visitor-pet' : 'guest-pet',
          'data-device-id': guest.deviceId,
          style: { opacity },
          role: interactive ? 'button' : undefined,
          tabIndex: interactive ? 0 : undefined,
          title: visiting
            ? guest.nickname + ' 正在你家串门，点开看记录'
            : guest.nickname + '，点开看串门记录',
          onClick: interactive ? () => onClick(guest) : undefined,
          onKeyDown: interactive
            ? (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onClick(guest)
              }
            : undefined
        },
        h(PetMedia, { pet: { name: guest.nickname, anim: guest.anim }, label: guest.nickname }),
        visiting
          ? h('span', { className: 'dsh-lp-visitor-badge', 'aria-hidden': 'true' }, '来访')
          : null,
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

      function LightStrip ({ neighbors, now, extraGuests = 0, onDropVisit, onOpenNeighbor }) {
        const [overId, setOverId] = React.useState(null)
        const droppable = typeof onDropVisit === 'function'
        const openable = typeof onOpenNeighbor === 'function'
        const visible = []
        for (const neighbor of neighbors) {
          if (neighbor === null || typeof neighbor !== 'object') continue
          // 拒绝过的邻居不再出现在客厅里（包括灯）；放行之前仍然要看得见。
          if (neighbor.status === 'denied') continue
          const deviceId = safeText(neighbor.deviceId, 64)
          if (deviceId === '') continue
          const nickname = safeText(neighbor.nickname, 32) || '邻居'
          const status = neighbor.status === 'allowed' ? 'allowed' : 'pending'
          const lastSeen = Number(neighbor.lastSeen)
          const age = Number.isFinite(lastSeen) ? now - lastSeen : NEIGHBOR_TTL_MS
          if (age >= NEIGHBOR_TTL_MS) continue
          const opacity = age <= NEIGHBOR_TTL_MS - NEIGHBOR_FADE_MS
            ? 1
            : Math.max(0, (NEIGHBOR_TTL_MS - age) / NEIGHBOR_FADE_MS)
          if (opacity <= 0.02) continue
          visible.push({ deviceId, nickname, opacity, status })
        }
        // 客厅里最多四位访客，其余折进这里的 +N；没有灯只有多余访客时也要显示。
        if (visible.length === 0 && extraGuests === 0) return null

        const startOver = (event, deviceId) => {
          if (!droppable) return
          event.preventDefault()
          try {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          } catch {
            // 某些浏览器在 dragover 阶段不允许读/写 dataTransfer
          }
          setOverId(deviceId)
        }

        const drop = (event, deviceId) => {
          event.preventDefault()
          setOverId(null)
          if (!droppable) return
          let payload = ''
          try {
            payload = event.dataTransfer?.getData('text/plain') ?? ''
          } catch {
            return
          }
          if (payload !== 'local-pet') return
          onDropVisit(deviceId)
        }

        const shown = visible.slice(0, MAX_LIGHTS)
        const extra = visible.length - shown.length + Math.max(0, extraGuests)
        return h('div', { className: 'dsh-lp-lights', 'aria-label': '邻居' },
          shown.map((neighbor) => h('div', {
            key: neighbor.deviceId,
            className: 'dsh-lp-light' + (overId === neighbor.deviceId ? ' dsh-lp-light-drop' : ''),
            style: { opacity: neighbor.opacity },
            role: openable ? 'button' : undefined,
            tabIndex: openable ? 0 : undefined,
            'aria-label': neighbor.nickname,
            title: neighbor.status === 'allowed'
              ? '点开可以派宠物去「' + neighbor.nickname + '」家，也可以直接把宠物拖到这里'
              : '先放行「' + neighbor.nickname + '」，才能让宠物过去；点开可以看看',
            onClick: openable ? () => onOpenNeighbor(neighbor) : undefined,
            onKeyDown: openable
              ? (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onOpenNeighbor(neighbor)
                }
              : undefined,
            onDragOver: (event) => startOver(event, neighbor.deviceId),
            onDragEnter: (event) => startOver(event, neighbor.deviceId),
            onDragLeave: () => setOverId(null),
            onDrop: (event) => drop(event, neighbor.deviceId)
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

      /**
       * 点邻居灯打开的小弹层：昵称 + 去串门 + 取消。
       * 「去串门」和拖到灯上走同一个宿主 action；弹层是少数几个 opt-in 指针事件的元素。
       */
      function NeighborPopover ({ neighbor, onVisit, onClose }) {
        const allowed = neighbor.status === 'allowed'
        return h('div', {
          className: 'dsh-lp-pop',
          'data-testid': 'neighbor-popover',
          role: 'dialog',
          'aria-label': '邻居 ' + neighbor.nickname
        },
        h('div', { className: 'dsh-lp-pop-name', title: neighbor.nickname }, neighbor.nickname),
        h('p', { className: 'dsh-lp-pop-sub' },
          allowed
            ? '把宠物派到「' + neighbor.nickname + '」家，最多待一分钟。'
            : '先放行「' + neighbor.nickname + '」，宠物才能过去。'),
        h('div', { className: 'dsh-lp-card-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-lp-card-btn',
            onClick: onVisit
          }, '去串门'),
          h('button', {
            type: 'button',
            className: 'dsh-lp-card-btn',
            onClick: onClose
          }, '取消')))
      }

      /**
       * 串门卡片：点访客（或出门时的本地宠物）打开，最近五条记录，最新在前。
       * 和邻居弹层、串门开关一样，是少数几个 opt-in 指针事件的元素；其余仍点穿。
       */
      function VisitCard ({ card, visits, onClose }) {
        const [busy, setBusy] = React.useState(false)
        const [failed, setFailed] = React.useState(false)

        if (card === null) return null
        const canRecall = card.kind === 'self'
        const canEnd = card.kind === 'visitor' && card.deviceId !== ''
        const action = canRecall
          ? { action: 'recall' }
          : canEnd
            ? { action: 'end-visit', deviceId: card.deviceId }
            : null

        const run = async () => {
          if (action === null || busy) return
          setBusy(true)
          setFailed(false)
          try {
            const res = await fetch(ACTION_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(action)
            })
            if (!res.ok) throw new Error('refused')
            onClose()
          } catch {
            setFailed(true)
          } finally {
            setBusy(false)
          }
        }

        const subtitle = card.kind === 'self'
          ? '宠物在「' + card.nickname + '」家，最多待一分钟。'
          : card.kind === 'visitor'
            ? '「' + card.nickname + '」正在你家串门。'
            : '「' + card.nickname + '」在邻居家；这张卡片只显示记录。'

        return h('div', {
          className: 'dsh-lp-card',
          'data-testid': 'visit-card',
          role: 'dialog',
          'aria-label': '串门记录'
        },
        h('button', {
          type: 'button',
          className: 'dsh-lp-card-close',
          title: '收起',
          'aria-label': '收起串门记录',
          disabled: busy,
          onClick: onClose
        }, '×'),
        h('div', { className: 'dsh-lp-card-head' }, '串门记录'),
        h('p', { className: 'dsh-lp-card-sub' }, subtitle),
        visits.length === 0
          ? h('p', { className: 'dsh-lp-card-empty' }, '还没有串门记录。')
          : h('ul', { className: 'dsh-lp-card-list' },
              visits.map((record, index) => h('li', {
                key: record.startedAt + ':' + index + ':' + record.nickname,
                className: 'dsh-lp-card-row'
              },
              h('span', {
                className: 'dsh-lp-card-dir',
                'data-dir': record.direction
              }, record.direction === 'out' ? '去' : '来'),
              h('span', { className: 'dsh-lp-card-who', title: record.nickname }, record.nickname),
              h('span', { className: 'dsh-lp-card-meta' },
                formatClock(record.startedAt) + ' · ' + formatDuration(record.durationMs))))),
        action !== null
          ? h('div', { className: 'dsh-lp-card-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-lp-card-btn',
                'data-kind': canRecall ? 'recall' : 'end',
                disabled: busy,
                onClick: run
              }, canRecall ? '召回来' : '结束串门'))
          : null,
        failed
          ? h('div', { className: 'dsh-lp-card-error', role: 'status' }, '没成功，再试一次')
          : null)
      }

      /** 失败提示条：只显示最近 20 秒内的 3 条，不接收指针事件。 */
      function NoticeStack ({ notices, now }) {
        const visible = notices.filter((notice) => now - notice.at < NOTICE_TTL_MS)
        if (visible.length === 0) return null
        return h('div', {
          className: 'dsh-lp-notices',
          role: 'status',
          'aria-live': 'polite'
        },
        visible.slice(0, 3).map((notice, index) => h('div', {
          key: notice.at + ':' + index + ':' + notice.text.slice(0, 8),
          className: 'dsh-lp-notice',
          'data-testid': 'notice'
        }, notice.text)))
      }

      function Room () {
        const snap = useSnapshot()
        const now = useNow(1000)
        const [card, setCard] = React.useState(null)
        const [neighborCard, setNeighborCard] = React.useState(null)
        const [savingAccept, setSavingAccept] = React.useState(false)
        if (!snap) return null

        const self = snap.self !== null && typeof snap.self === 'object' ? snap.self : {}
        const pet = self.pet !== null && typeof self.pet === 'object' ? self.pet : null
        const bridge = self.bridge !== null && typeof self.bridge === 'object' ? self.bridge : null
        const nickname = safeText(self.nickname, 32) || '我'
        const label = (pet !== null ? safeText(pet.name, 64) : '') || nickname
        const neighbors = Array.isArray(snap.neighbors) ? snap.neighbors : []
        // 宿主没给这个字段时按“允许串门”画，兼容旧快照。
        const acceptVisits = snap.acceptVisits !== false
        const out = readOut(self.out)
        const visitors = readVisitors(snap.visitors)
        const visitRecords = readVisits(snap.visits)
        const notices = readNotices(snap.notices)
        const visitorIds = new Set(visitors.map((visitor) => visitor.deviceId))
        // 串门访客优先画；同一台机器的心跳影子不再重复画一遍。
        const guests = readGuests(snap.guests).filter((guest) => !visitorIds.has(guest.deviceId))
        // 同屏最多四位（串门访客 + 心跳影子），剩下的只计数，交给灯条的 +N。
        const shownVisitors = visitors.slice(0, MAX_GUESTS_ON_SCREEN)
        const remaining = Math.max(0, MAX_GUESTS_ON_SCREEN - shownVisitors.length)
        const shownGuests = guests.slice(0, remaining)
        const extraGuests = visitors.length - shownVisitors.length + guests.length - shownGuests.length
        const prompt = readPrompt(snap.prompt)

        const startVisit = async (deviceId) => {
          if (typeof deviceId !== 'string' || deviceId === '') return
          try {
            await fetch(ACTION_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'visit', deviceId })
            })
          } catch {
            // 宿主没接住时下一轮快照不会变成“出门了”；失败提示由宿主 notice 给出
          }
        }

        const openGuestCard = (guest) => {
          setNeighborCard(null)
          setCard({
            kind: visitorIds.has(guest.deviceId) ? 'visitor' : 'guest',
            deviceId: guest.deviceId,
            nickname: guest.nickname
          })
        }

        // 点邻居灯：打开小弹层；和串门记录卡片互斥，避免两块浮层叠在一起。
        const openNeighbor = (neighbor) => {
          setCard(null)
          setNeighborCard({
            deviceId: neighbor.deviceId,
            nickname: neighbor.nickname,
            status: neighbor.status
          })
        }

        const visitNeighbor = () => {
          const target = neighborCard
          setNeighborCard(null)
          if (target !== null) startVisit(target.deviceId)
        }

        const toggleAcceptVisits = async () => {
          if (savingAccept) return
          setSavingAccept(true)
          try {
            await fetch(ACTION_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'accept-visits', enabled: !acceptVisits })
            })
          } catch {
            // 下一轮快照会告诉我们开关没变；不弹错误层
          } finally {
            setSavingAccept(false)
          }
        }

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

        const localPet = out !== null
          ? h('div', {
              className: 'dsh-lp-pet dsh-lp-pet-out',
              'data-testid': 'local-pet-out',
              title: out.phase === 'active'
                ? '在「' + out.nickname + '」家串门，点开看记录'
                : '正在去「' + out.nickname + '」家',
              onClick: () => {
                setNeighborCard(null)
                setCard({ kind: 'self', deviceId: '', nickname: out.nickname })
              }
            },
            h('span', { className: 'dsh-lp-out-text' }, out.phase === 'active' ? '出门了' : '出门中…'),
            h('span', { className: 'dsh-lp-name' }, out.phase === 'active'
              ? '在「' + out.nickname + '」家'
              : '去「' + out.nickname + '」家'))
          : pet !== null
            ? h('div', {
                className: 'dsh-lp-pet',
                'data-testid': 'local-pet',
                draggable: true,
                title: '把宠物拖到邻居灯上，让它出门串门',
                onDragStart: (event) => {
                  try {
                    event.dataTransfer?.setData('text/plain', 'local-pet')
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                  } catch {
                    // 浏览器不让写 dataTransfer：拖放会自然失败，不影响点击
                  }
                }
              },
              h(PetMedia, { pet, label }),
              h('span', {
                className: 'dsh-lp-name',
                title: '双击改昵称 · 邻居看到：' + nickname,
                onDoubleClick: (event) => {
                  event?.stopPropagation?.()
                  rename()
                }
              }, label))
            : null

        return h('div', { className: 'dsh-lp-root' },
          h(LightStrip, {
            neighbors,
            now,
            extraGuests,
            onDropVisit: startVisit,
            onOpenNeighbor: openNeighbor
          }),
          h(NoticeStack, { notices, now }),
          prompt !== null ? h(PromptCard, { key: prompt.deviceId, prompt }) : null,
          neighborCard !== null
            ? h(NeighborPopover, {
                key: 'neighbor:' + neighborCard.deviceId,
                neighbor: neighborCard,
                onVisit: visitNeighbor,
                onClose: () => setNeighborCard(null)
              })
            : null,
          card !== null
            ? h(VisitCard, {
                key: card.kind + ':' + (card.deviceId ?? '') + ':' + card.nickname,
                card,
                visits: visitRecords,
                onClose: () => setCard(null)
              })
            : null,
          h('div', { className: 'dsh-lp-room' },
            h('button', {
              type: 'button',
              className: 'dsh-lp-door',
              'data-testid': 'accept-visits',
              'data-on': acceptVisits ? 'true' : 'false',
              'aria-pressed': acceptVisits,
              disabled: savingAccept,
              title: acceptVisits
                ? '允许邻居把宠物派过来；点一下关掉（邻居仍然看得见、心跳照常）'
                : '串门已关：邻居仍然可见，但宠物进不来；点一下重新打开',
              onClick: toggleAcceptVisits
            }, acceptVisits ? '允许串门' : '串门已关'),
            shownVisitors.map((visitor) => h(GuestPet, {
              key: 'visitor:' + visitor.deviceId,
              guest: visitor,
              now,
              visiting: true,
              onClick: openGuestCard
            })),
            shownGuests.map((guest) => h(GuestPet, {
              key: 'guest:' + guest.deviceId,
              guest,
              now,
              onClick: openGuestCard
            })),
            localPet,
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
