// The app's logo mark (play triangle over a photo frame), drawn inline so it themes and scales crisply.
import { useId } from 'react'

export function AppMark({ size = 22 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className="app-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b9bff" />
          <stop offset="1" stopColor="#7a5cff" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${id}-g)`} />
      <path d="M5.5 24.5 L12 16.5 L16 21 L19 18 L26.5 24.5 Z" fill="#ffffff" fillOpacity="0.35" />
      <circle cx="23" cy="9.5" r="2.4" fill="#ffffff" fillOpacity="0.45" />
      <path d="M12.2 9.2 L21.6 15.2 a0.9 0.9 0 0 1 0 1.5 L12.2 22.7 a0.9 0.9 0 0 1 -1.4 -0.75 V9.95 a0.9 0.9 0 0 1 1.4 -0.75 Z" fill="#ffffff" />
    </svg>
  )
}
