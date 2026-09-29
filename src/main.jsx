import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './booking-system.jsx'

// A tab left open across a deploy can fail to fetch a lazily loaded chunk (PDF export
// libraries); reload once to pick up the new build instead of failing silently.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('fb_chunk_reload')) return
    sessionStorage.setItem('fb_chunk_reload', '1')
  } catch { /* storage blocked — still reload */ }
  e.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
