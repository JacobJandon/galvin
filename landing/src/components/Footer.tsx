import styles from './Footer.module.css'

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.top}>
        <span className={styles.wordmark}>Galvin</span>
        <nav className={styles.links}>
          <a href="https://github.com/JacobJandon/galvin" target="_blank" rel="noopener">GitHub</a>
          <a href="../DOCUMENTATION.md">Docs</a>
          <a href="../ARCHITECTURE.md">Architecture</a>
          <a href="../ROADMAP.md">Roadmap</a>
          <a href="#constitution">Constitution</a>
        </nav>
      </div>
      <p className={styles.bottom}>
        MIT License · powered by automaton · solvatron.xyz · No bailout. No rescue. Only the balance.
      </p>
    </footer>
  )
}
