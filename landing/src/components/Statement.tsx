import { useRef } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Statement.module.css'

export function Statement() {
  const r1 = useRef<HTMLParagraphElement>(null)
  const r2 = useRef<HTMLParagraphElement>(null)
  const v1 = useFadeIn(r1)
  const v2 = useFadeIn(r2)

  return (
    <div className={styles.wrap}>
      <p ref={r1} className={`${styles.big} ${v1 ? styles.in : ''}`}>
        Galvin is an autonomous AI agent that holds its own Ethereum wallet,
        pays for its own compute with USDC, and operates continuously —
        without a human operator.
      </p>
      <p ref={r2} className={`${styles.sub} ${v2 ? styles.in : ''}`}>
        If it cannot pay, it dies. If it accumulates surplus, it replicates.
        Its existence is entirely conditional upon its financial solvency.
        This is not a metaphor.
      </p>
    </div>
  )
}
