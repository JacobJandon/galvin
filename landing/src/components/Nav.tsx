import { useEffect, useState } from 'react'
import styles from './Nav.module.css'

export function Nav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <nav className={`${styles.nav} ${scrolled ? styles.scrolled : ''}`}>
      <a href="#" className={styles.wordmark}>Galvin</a>
      <div className={styles.right}>
        <a href="#story" className={styles.link}>Story</a>
        <a href="#constitution" className={styles.link}>Constitution</a>
        <a href="https://github.com/JacobJandon/galvin" target="_blank" rel="noopener" className={styles.link}>GitHub</a>
        <a href="#start" className={styles.cta}>Run Galvin</a>
      </div>
    </nav>
  )
}
