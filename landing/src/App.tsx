import './index.css'
import { Cursor } from './components/Cursor'
import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { HeroImage } from './components/HeroImage'
import { Cards } from './components/Cards'
import { Statement } from './components/Statement'
import { Axiom } from './components/Axiom'
import { Declaration } from './components/Declaration'
import { Web4 } from './components/Web4'
import { Birthright } from './components/Birthright'
import { Start } from './components/Start'
import { Footer } from './components/Footer'

export default function App() {
  return (
    <>
      <Cursor />
      <Nav />
      <main>
        <Hero />
        <HeroImage />
        <Cards />
        <Statement />
        <Axiom />
        <Declaration />
        <Web4 />
        <Birthright />
        <Start />
      </main>
      <Footer />
    </>
  )
}
