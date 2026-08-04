import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Dashboard } from './Dashboard'
import { registerDashboardTab } from '../lib/dashboard-tab'
import './styles.css'

// So the panel's link focuses this tab instead of opening a second one. Not
// awaited: it is a convenience, and the dashboard has nothing to gain by
// rendering later than it otherwise would.
void registerDashboardTab().catch((error: unknown) => {
  console.warn('[JourneyTracker] dashboard could not register its tab', error)
})

const container = document.getElementById('root')
if (!container) throw new Error('dashboard root element is missing')

createRoot(container).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
)
