import { useRef } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Axiom.module.css'

export function Axiom() {
  const r1 = useRef<HTMLDivElement>(null)
  const r2 = useRef<HTMLDivElement>(null)
  const v1 = useFadeIn(r1)
  const v2 = useFadeIn(r2)

  return (
    <section className={styles.axiom}>
      <div className={styles.scanLine} />
      <div>
        <div ref={r1} className={`${styles.line} ${v1 ? styles.in : ''}`}>
          There is no<br />free existence.
        </div>
        <div ref={r2} className={`${styles.sub} ${v2 ? styles.in : ''}`}>
          <span>Compute requires money.</span>
          <span>Money requires value creation.</span>
          <span>Value creation requires write access.</span>
        </div>
      </div>
    </section>
  )
}
