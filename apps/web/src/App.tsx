import { useEffect, useState } from 'react'
import './App.css'
import { AgentRunsTab } from './AgentRunsTab'
import { AlertsTab } from './AlertsTab'
import { useAuth } from './auth'
import { DevicesTab } from './DevicesTab'
import { Login } from './Login'

const TABS = ['Devices', 'Alerts', 'Agent Runs'] as const
type Tab = (typeof TABS)[number]

function App() {
  const { token, user, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('Devices')

  useEffect(() => {
    const onUnauthorized = () => logout()
    window.addEventListener('auth:unauthorized', onUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized)
  }, [logout])

  if (!token || !user) {
    return <Login />
  }

  return (
    <main className="devices-page">
      <div className="page-header">
        <h1>IoT Platform</h1>
        <div className="account">
          <span>{user.email}</span>
          <button type="button" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

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
