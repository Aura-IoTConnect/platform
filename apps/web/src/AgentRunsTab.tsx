import { useEffect, useState } from 'react'
import { apiGet, apiSend } from './api'
import type { AgentRun } from './types'

export function AgentRunsTab() {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    apiGet<AgentRun[]>('/api/agents/runs')
      .then(setRuns)
      .catch(() => setError('Failed to load agent runs'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const sendFeedback = async (id: string, score: number) => {
    try {
      await apiSend(`/api/agents/runs/${id}/feedback`, 'POST', { score })
      load()
    } catch {
      setError('Failed to submit feedback')
    }
  }

  return (
    <section>
      <p className="hint">
        Runs are triggered from apps/workers (e.g. automatically on a CRITICAL alert, or via the
        agent endpoints). This tab reviews results and scores them, closing the feedback loop.
      </p>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : runs.length === 0 ? (
        <p>No agent runs yet.</p>
      ) : (
        <ul className="record-list">
          {runs.map((run) => (
            <li key={run.id} className="agent-run">
              <div className="record-main">
                <span className="record-title">
                  {run.agent.name}
                  <span className={`status-pill status-${run.status.toLowerCase()}`}>{run.status}</span>
                </span>
                <span className="record-subtitle">{new Date(run.createdAt).toLocaleString()}</span>
                {run.output != null && (
                  <pre className="agent-output">{JSON.stringify(run.output, null, 2)}</pre>
                )}
              </div>
              <div className="record-actions">
                <button
                  type="button"
                  disabled={run.feedback?.score === 1}
                  onClick={() => sendFeedback(run.id, 1)}
                >
                  👍
                </button>
                <button
                  type="button"
                  disabled={run.feedback?.score === -1}
                  onClick={() => sendFeedback(run.id, -1)}
                >
                  👎
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
