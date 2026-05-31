import { useEffect, useState, type RefObject } from 'react'

export function useFadeIn(ref: RefObject<Element | null>, threshold = 0.12) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect() } },
      { threshold, rootMargin: '0px 0px -40px 0px' }
    )
    if (ref.current) io.observe(ref.current)
    return () => io.disconnect()
  }, [ref, threshold])

  return visible
}
