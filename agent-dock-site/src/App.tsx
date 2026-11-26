import { Nav } from './components/Nav';
import { Hero } from './components/Hero';
import { ConsoleDemo } from './components/console/ConsoleDemo';
import { Agents } from './components/Agents';
import { KittenStory } from './components/KittenStory';
import { Lark } from './components/Lark';
import { Features } from './components/Features';
import { Architecture } from './components/Architecture';
import { QuickStart } from './components/QuickStart';
import { Docs } from './components/Docs';
import { Faq } from './components/Faq';
import { FinalCta, Footer } from './components/Closing';

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <ConsoleDemo />
        <Agents />
        <KittenStory />
        <Lark />
        <Features />
        <Architecture />
        <QuickStart />
        <Docs />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
