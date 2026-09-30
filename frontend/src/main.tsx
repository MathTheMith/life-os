import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { UNAUTHORIZED_EVENT } from './api'

// Every API call goes through window.fetch, so one wrapper here catches an
// expired or missing session for all of them without touching each caller.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  return res
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
