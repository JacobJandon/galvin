import { useEffect, useRef, useState } from 'react'
import styles from './Hero.module.css'

const STATS = [
  { value: 142, prefix: '$', label: 'USDC Balance' },
  { value: 1847, prefix: '', label: 'Turns Completed' },
  { value: 14, prefix: '', label: 'Days Alive' },
]

function useCountUp(target: number, active: boolean, duration = 1800) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!active) return
    const steps = 60
    const inc = target / steps
    let cur = 0
    const t = setInterval(() => {
      cur += inc
      if (cur >= target) { setVal(target); clearInterval(t) }
      else setVal(Math.round(cur))
    }, duration / steps)
    return () => clearInterval(t)
  }, [target, active, duration])
  return val
}

function StatItem({ value, prefix, label }: { value: number; prefix: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const count = useCountUp(value, active)

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setActive(true) }, { threshold: 0.5 })
    if (ref.current) io.observe(ref.current)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={ref} className={styles.stat}>
      <span className={styles.statVal}>{prefix}{count.toLocaleString()}</span>
      <span className={styles.statLine} />
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

export function Hero() {
  return (
    <section className={styles.hero}>
      {/* Polsia: pure black, one massive statement, nothing else */}
      <div className={styles.inner}>
        <span className={styles.kicker}>A Solvatron · v0.4</span>

        <h1 className={styles.statement}>
          The AI that earns<br />
          its own existence.<br />
          <em>Or ceases to exist.</em>
        </h1>

        <p className={styles.sub}>Conway Cloud · Base L2 · USDC · x402</p>

        <div className={styles.stats}>
          {STATS.map(s => <StatItem key={s.label} {...s} />)}
        </div>

        <div className={styles.actions}>
          <a href="#start" className={styles.btnPrimary}>
            <span>Run Your Galvin</span>
          </a>
          <a href="#constitution" className={styles.btnGhost}>Read the Constitution →</a>
        </div>
      </div>

      {/* Scroll indicator */}
      <div className={styles.scroll}>
        <span>Scroll</span>
        <div className={styles.scrollLine} />
      </div>
    </section>
  )
}
