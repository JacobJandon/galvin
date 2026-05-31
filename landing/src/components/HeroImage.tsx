import { useEffect, useRef } from 'react'
import styles from './HeroImage.module.css'

export function HeroImage() {
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const onScroll = () => {
      if (imgRef.current) {
        imgRef.current.style.transform = `translateY(${window.scrollY * 0.18}px)`
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className={styles.wrap}>
      <img
        ref={imgRef}
        src="/images/sovereign-intelligence.jpg"
        alt="Machine and human hands reaching — sovereign intelligence"
        className={styles.img}
        loading="eager"
      />
      <div className={styles.vignette} />
    </div>
  )
}
