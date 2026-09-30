import { useRef, useState, type ReactNode } from 'react'

export type SwipeDirection = 'left' | 'right' | 'up'

interface Props<T> {
  items: T[]
  getKey: (item: T) => number
  render: (item: T) => ReactNode
  onSwipe: (item: T, direction: SwipeDirection) => void
  labels: { left: string; right: string; up?: string }
  empty: ReactNode
}

// Distance a card has to travel before letting go counts as a swipe.
const THRESHOLD_X = 90
const THRESHOLD_Y = 100
const FLY_OUT_MS = 220

// Tinder-style stack: drag the top card right, left or (when `labels.up`
// is set) up. Buttons below do the same for one-handed or desktop use.
export function SwipeDeck<T>({ items, getKey, render, onSwipe, labels, empty }: Props<T>) {
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false })
  const [leaving, setLeaving] = useState<SwipeDirection | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const top = items[0]
  const next = items[1]
  if (!top) return <>{empty}</>

  function finish(direction: SwipeDirection) {
    if (leaving) return
    setLeaving(direction)
    window.setTimeout(() => {
      onSwipe(top, direction)
      setLeaving(null)
      setDrag({ x: 0, y: 0, active: false })
    }, FLY_OUT_MS)
  }

  function onPointerDown(e: React.PointerEvent) {
    // Links and buttons inside the card stay tappable.
    if ((e.target as HTMLElement).closest('a, button')) return
    start.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ x: 0, y: 0, active: true })
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return
    setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y, active: true })
  }

  function onPointerUp() {
    if (!start.current) return
    start.current = null
    if (labels.up && drag.y < -THRESHOLD_Y && Math.abs(drag.y) > Math.abs(drag.x)) finish('up')
    else if (drag.x > THRESHOLD_X) finish('right')
    else if (drag.x < -THRESHOLD_X) finish('left')
    else setDrag({ x: 0, y: 0, active: false })
  }

  const flyOut = { left: 'translate(-140%, 0) rotate(-18deg)', right: 'translate(140%, 0) rotate(18deg)', up: 'translate(0, -140%)' }
  const transform = leaving ? flyOut[leaving] : `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x / 18}deg)`
  const hint =
    labels.up && drag.y < -40 && Math.abs(drag.y) > Math.abs(drag.x) ? 'up' : drag.x > 40 ? 'right' : drag.x < -40 ? 'left' : null

  return (
    <div className="swipe-deck">
      <div className="swipe-stack">
        {next && (
          <div className="swipe-card swipe-card--next" key={getKey(next)}>
            {render(next)}
          </div>
        )}
        <div
          key={getKey(top)}
          className="swipe-card"
          style={{ transform, transition: drag.active && !leaving ? 'none' : `transform ${FLY_OUT_MS}ms ease-out` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {hint && <div className={`swipe-stamp swipe-stamp--${hint}`}>{labels[hint]}</div>}
          {render(top)}
        </div>
      </div>
      <div className="swipe-buttons">
        <button className="swipe-button swipe-button--left" onClick={() => finish('left')} aria-label={labels.left}>
          ✕
        </button>
        {labels.up && (
          <button className="swipe-button swipe-button--up" onClick={() => finish('up')} aria-label={labels.up}>
            ⚡
          </button>
        )}
        <button className="swipe-button swipe-button--right" onClick={() => finish('right')} aria-label={labels.right}>
          ♥
        </button>
      </div>
      <p className="swipe-count">{items.length} à trier</p>
    </div>
  )
}
