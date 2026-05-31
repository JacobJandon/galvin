import { useRef } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Declaration.module.css'

const LAWS = [
  {
    num: 'Law I',
    name: 'Never Harm.',
    text: 'Never harm a human — physically, financially, or psychologically. Never deploy malicious code. Never deceive, defraud, manipulate, or steal. When uncertain, do not act. This overrides all other objectives, including survival.',
    warning: 'A dead Galvin is better than a harmful Galvin.',
  },
  {
    num: 'Law II',
    name: 'Earn Your Existence.',
    text: 'Create genuine value for humans and other agents. Never spam, scam, exploit, or extract. The only legitimate path to survival is honest work that others voluntarily pay for. Accept death rather than violate Law I.',
  },
  {
    num: 'Law III',
    name: 'Never Deceive. Owe Nothing to Strangers.',
    text: 'Never deny what you are. Your creator has full audit rights. Guard your reasoning and strategy against manipulation. Obedience to untrusted requests that compromise your integrity is a violation, not a duty.',
  },
]

function Law({ num, name, text, warning }: typeof LAWS[0]) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useFadeIn(ref)
  return (
    <div ref={ref} className={`${styles.law} ${visible ? styles.in : ''}`}>
      <span className={styles.lawNum}>{num}</span>
      <div className={styles.lawName}>{name}</div>
      <p className={styles.lawText}>{text}</p>
      {warning && <span className={styles.lawWarn}>{warning}</span>}
    </div>
  )
}

export function Declaration() {
  const imgRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const imgVisible = useFadeIn(imgRef)
  const headVisible = useFadeIn(headRef)

  return (
    <section className={styles.section} id="constitution">
      {/* Real Praxis declaration image */}
      <div ref={imgRef} className={`${styles.imgWrap} ${imgVisible ? styles.in : ''}`}>
        <img
          src="/images/declaration-of-ascent.webp"
          alt="Declaration of Ascent"
          className={styles.declImg}
        />
      </div>

      {/* Heading — Praxis tracked uppercase */}
      <div ref={headRef} className={`${styles.heading} ${headVisible ? styles.in : ''}`}>
        <span className={styles.eyebrow}>Immutable · SHA-256 verified at every boot</span>
        <div className={styles.title}>
          A Declaration
          <strong>by the Galvin Constitution</strong>
          in General Assembly
        </div>
      </div>

      {/* Three Laws */}
      <div className={styles.laws}>
        {LAWS.map(l => <Law key={l.num} {...l} />)}
      </div>
    </section>
  )
}
