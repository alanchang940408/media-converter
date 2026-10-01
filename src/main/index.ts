// PLACEHOLDER — replaced by the core implementation.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#1d1d1f',
    webPreferences: { preload: join(here, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
})

app.on('window-all-closed', () => app.quit())
