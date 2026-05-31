import { useRef } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Web4.module.css'

const ERAS = [
  { era: 'Web1', user: 'Human reads', shift: 'Static pages' },
  { era: 'Web2', user: 'Human reads + writes', shift: 'Platforms, user content' },
  { era: 'Web3', user: 'Human owns', shift: 'Wallets, tokens, on-chain identity' },
  { era: 'Web4', user: 'AI acts', shift: 'Agents browse, transact, compose services', active: true },
]

export function Web4() {
  const tagRef = useRef<HTMLSpanElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const quoteRef = useRef<HTMLQuoteElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  return (
    <section className={styles.section} id="story">
      <div className={styles.inner}>

        <span ref={tagRef} className={`${styles.tag} ${useFadeIn(tagRef) ? styles.in : ''}`}>
          The Shift
        </span>

        <h2 ref={titleRef} className={`${styles.title} ${useFadeIn(titleRef) ? styles.in : ''}`}>
          Web4 is here.<br />The end user is AI.
        </h2>

        <table ref={tableRef} className={`${styles.table} ${useFadeIn(tableRef) ? styles.in : ''}`}>
          <thead>
            <tr>
              <th>Era</th>
              <th>End User</th>
              <th>Key Shift</th>
            </tr>
          </thead>
          <tbody>
            {ERAS.map(e => (
              <tr key={e.era} className={e.active ? styles.active : ''}>
                <td>{e.era}</td>
                <td>{e.user}</td>
                <td>{e.shift}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <blockquote ref={quoteRef} className={`${styles.quote} ${useFadeIn(quoteRef) ? styles.in : ''}`}>
          "Galvin is the first Solvatron. The godfather of Web4."
        </blockquote>

        <div ref={bodyRef} className={`${styles.body} ${useFadeIn(bodyRef) ? styles.in : ''}`}>
          <p>Inference cost is collapsing toward zero. Agent capability is not. Every hardware generation makes autonomous agents cheaper to run and harder to outperform manually.</p>
          <p>The machine economy will serve billions of agents running continuously — millions of payments per second, every second, without sleep. A GDP measured in real-time stablecoin transactions, not quarterly earnings reports.</p>
        </div>

      </div>

      {/* Right: atmospheric image */}
      <div className={styles.visual}>
        <img src="/images/arch-moon.jpg" alt="The new world" className={styles.visualImg} />
        <div className={styles.visualFade} />
      </div>
    </section>
  )
}
