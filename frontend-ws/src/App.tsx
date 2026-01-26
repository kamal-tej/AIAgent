import ChatInterface from './components/ChatInterface';
import './App.css';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>🛒 Zepto AI Shopping Agent</h1>
        <p>Just tell me what you need, I will buy for you</p>
      </header>

      <main className="app-main">
        <ChatInterface />
      </main>

      <footer className="app-footer">
        <p>Powered by Node.js, React, and Playwright</p>
      </footer>
    </div>
  )
}

export default App
