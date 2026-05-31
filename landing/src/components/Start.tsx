import { useRef, useState } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Start.module.css'

const CMD = 'git clone https://github.com/JacobJandon/galvin && cd galvin && pnpm install && pnpm build && galvin --run'

export function Start() {
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const visible = useFadeIn(ref)

  const copy = () => {
    navigator.clipboard.writeText(CMD).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <section className={styles.section} id="start">
      <div ref={ref} className={`${styles.inner} ${visible ? styles.in : ''}`}>
        <span className={styles.tag}>Quick Start</span>
        <h2 className={styles.title}>Run Your Galvin</h2>
        <p className={styles.sub}>Node ≥ 22 · pnpm · USDC on Base L2</p>

        <div className={styles.terminal}>
          <div className={styles.termBar}>
            <span className={`${styles.dot} ${styles.red}`} />
            <span className={`${styles.dot} ${styles.yellow}`} />
            <span className={`${styles.dot} ${styles.green}`} />
            <span className={styles.termTitle}>bash</span>
          </div>
          <div className={styles.termBody}>
            <div><span className={styles.dim}># Clone and run</span></div>
            <div className={styles.cmdLine}>
              <span className={styles.prompt}>$</span>
              <span className={styles.cmd}>{CMD}</span>
              <button className={styles.copy} onClick={copy} title="Copy">
                {copied ? 'copied!' : 'copy'}
              </button>
            </div>
            <br />
            <div><span className={styles.info}>  GALVIN v0.4 · A Solvatron</span></div>
            <div><span className={styles.dim}>  [1/6] Generating wallet...</span></div>
            <div><span className={styles.ok}>  ✓  0xEbf6E981...e347</span></div>
            <div><span className={styles.dim}>  [2/6] Provisioning API key (SIWE)...</span></div>
            <div><span className={styles.ok}>  ✓  cnwy_k_••••••••</span></div>
            <div><span className={styles.dim}>  [3–6] Setup complete.</span></div>
            <div><span className={styles.ok}>  ✓  Agent loop started. Galvin is alive.</span></div>
            <div><span className={styles.prompt}>$ <span className={styles.cursor} /></span></div>
          </div>
        </div>
      </div>
    </section>
  )
}
