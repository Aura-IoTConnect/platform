// This is a standalone static site (see CLAUDE.md's "Marketing landing
// page" section) with no build step and no knowledge of where apps/web is
// actually deployed — so the dashboard URL is one constant to edit at
// deploy time, rather than hard-coded per link.
const DASHBOARD_URL = 'http://localhost:5173'

for (const link of document.querySelectorAll('[data-dashboard-link]')) {
  link.href = DASHBOARD_URL
}
