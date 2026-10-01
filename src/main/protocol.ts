// media://local/<encodeURIComponent(absPath)> — streams local media files to <video>/<img> with Range support.
import { protocol } from 'electron'
import { handleMediaRequest, MEDIA_SCHEME } from './mediaResponse'

export { handleMediaRequest, MEDIA_SCHEME, mimeFor, parseRange, pathFromMediaUrl } from './mediaResponse'

/** Must run before app 'ready'. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: false, corsEnabled: true },
    },
  ])
}

/** Call after app 'ready'. */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) =>
    handleMediaRequest(request).catch(
      (err) => new Response(err instanceof Error ? err.message : String(err), { status: 500 }),
    ),
  )
}
