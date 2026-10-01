// Renderer entry: resolve window.api (Electron preload or the browser mock), then mount the app.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import './styles/app.css'
import './styles/queue.css'
import './styles/editors.css'
import './styles/modals.css'
import './styles/views.css'
import './styles/fileops.css'
import { ensureApi } from './api'
import { App } from './App'

async function boot(): Promise<void> {
  await ensureApi()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
