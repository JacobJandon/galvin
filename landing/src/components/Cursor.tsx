import { useEffect, useRef } from 'react'

export function Cursor() {
  const dot = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const pos = useRef({ x: -100, y: -100, rx: -100, ry: -100 })

  useEffect(() => {
    const move = (e: MouseEvent) => {
      pos.current.x = e.clientX
      pos.current.y = e.clientY
      if (dot.current) {
        dot.current.style.left = e.clientX + 'px'
        dot.current.style.top = e.clientY + 'px'
      }
    }
    document.addEventListener('mousemove', move)

    let raf: number
    const loop = () => {
      pos.current.rx += (pos.current.x - pos.current.rx) * 0.1
      pos.current.ry += (pos.current.y - pos.current.ry) * 0.1
      if (ring.current) {
        ring.current.style.left = pos.current.rx + 'px'
        ring.current.style.top = pos.current.ry + 'px'
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const over = () => {
      dot.current?.classList.add('hovered')
      ring.current?.classList.add('hovered')
    }
    const out = () => {
      dot.current?.classList.remove('hovered')
      ring.current?.classList.remove('hovered')
    }
    document.querySelectorAll('a,button').forEach(el => {
      el.addEventListener('mouseenter', over)
      el.addEventListener('mouseleave', out)
    })

    return () => {
      document.removeEventListener('mousemove', move)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <>
      <div ref={dot} style={{
        position: 'fixed', zIndex: 99999, pointerEvents: 'none',
        width: 6, height: 6, borderRadius: '50%',
        background: 'var(--gold)',
        transform: 'translate(-50%,-50%)',
        transition: 'width 200ms,height 200ms',
      }} />
      <div ref={ring} style={{
        position: 'fixed', zIndex: 99998, pointerEvents: 'none',
        width: 30, height: 30, borderRadius: '50%',
        border: '1px solid rgba(201,168,76,0.4)',
        transform: 'translate(-50%,-50%)',
        transition: 'width 200ms,height 200ms,border-color 200ms',
      }} />
    </>
  )
}
