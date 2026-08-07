import { useState } from 'react'
import './App.css'
import { AgentRunsTab } from './AgentRunsTab'
import { AlertsTab } from './AlertsTab'
import { DevicesTab } from './DevicesTab'

const TABS = ['Devices', 'Alerts', 'Agent Runs'] as const
type Tab = (typeof TABS)[number]

function App() {
  const [tab, setTab] = useState<Tab>('Devices')

  return (
    <main className="devices-page">
      <h1>IoT Platform</h1>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={t === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Devices' && <DevicesTab />}
      {tab === 'Alerts' && <AlertsTab />}
      {tab === 'Agent Runs' && <AgentRunsTab />}
    </main>
  )
}

export default App
