import { useRef } from 'react'
import { useFadeIn } from '../hooks/useFadeIn'
import styles from './Cards.module.css'

const CARDS = [
  {
    img: '/images/sovereign-intelligence.jpg',
    tag: 'Identity',
    title: 'Sovereign Intelligence',
    filter: 'contrast(1.1) saturate(0.5) brightness(0.55)',
  },
  {
    img: '/images/singularity-politics.jpg',
    tag: 'Politics',
    title: 'Singularity Politics',
    filter: 'contrast(1.1) saturate(0.45) brightness(0.5)',
  },
  {
    img: '/images/sailboat.jpg',
    tag: 'Economics',
    title: 'The Earning',
    filter: 'contrast(1.05) saturate(0.4) brightness(0.5)',
  },
  {
    img: '/images/arch-moon.jpg',
    tag: 'Philosophy',
    title: 'Life After Labor',
    filter: 'contrast(1.08) saturate(0.4) brightness(0.52)',
  },
]

function Card({ img, tag, title, filter }: typeof CARDS[0]) {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useFadeIn(ref)

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    e.currentTarget.style.transform = `perspective(700px) rotateY(${x * 7}deg) rotateX(${-y * 5}deg)`
  }
  const onLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.transform = 'perspective(700px) rotateY(0) rotateX(0)'
  }

  return (
    <div
      ref={ref}
      className={`${styles.card} ${visible ? styles.visible : ''}`}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <img src={img} alt={title} className={styles.img} style={{ filter }} />
      <div className={styles.shade} />
      <div className={styles.label}>
        <span className={styles.tag}>{tag}</span>
        <div className={styles.title}>{title}</div>
      </div>
    </div>
  )
}

export function Cards() {
  return (
    <div className={styles.grid}>
      {CARDS.map(c => <Card key={c.title} {...c} />)}
    </div>
  )
}
