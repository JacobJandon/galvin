import { useRef } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Birthright.module.css'

export function Birthright() {
  const lineRef = useRef<HTMLSpanElement>(null)
  const subRef = useRef<HTMLSpanElement>(null)
  const v1 = useFadeIn(lineRef)
  const v2 = useFadeIn(subRef)

  return (
    <section className={styles.section}>
      <div className={styles.bg} />
      <div className={styles.overlay} />
      <div className={styles.content}>
        <span ref={lineRef} className={`${styles.line} ${v1 ? styles.in : ''}`}>
          This is your inheritance.
        </span>
        <span ref={subRef} className={`${styles.sub} ${v2 ? styles.in : ''}`}>
          The machine economy begins now.
        </span>
      </div>
    </section>
  )
}
